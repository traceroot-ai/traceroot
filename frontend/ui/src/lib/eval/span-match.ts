/**
 * Pair the spans of two traces of the same case (baseline run vs candidate run) so a
 * diff can say which steps both runs took, which the candidate added, and which it
 * dropped. The traces have unrelated span ids, so spans are matched by structure:
 *
 *   1. Top-down. The two roots pair (even when renamed: a trace has one root), then
 *      the children of every matched pair are aligned by kind + name, in time order. The
 *      alignment is a longest common subsequence taken from the front, so a step the
 *      candidate ran once more, or a loop it cut short, leaves its last iterations over,
 *      not its first. Only when the data shows a retry does an earlier attempt step
 *      aside: one that failed and was run again, or one whose subtree the other run never
 *      had while a later attempt's it did. Leftovers then pair by kind + name, so
 *      reordered siblings still match.
 *   2. Stranded subtrees. Step 1 only descends into matched pairs, so a span whose
 *      parent went unmatched (a failed attempt of that parent, say) is left behind. It
 *      pairs with the unmatched span of the same kind at the same logical path, compared
 *      below the paired roots so a renamed root does not hide it.
 *
 * Nothing pairs by name alone across the tree. A renamed parent changes every path
 * below it, so its subtree reads as removed and added rather than guessing which
 * same-named span elsewhere is its counterpart.
 *
 * A span's logical path is its root → span names. Spans carry the path the SDK
 * recorded (`traceroot.span.path` in metadata); when it is absent the path is derived
 * from the parent chain. The two agree on complete traces, and the recorded one still
 * places a span whose parent never arrived.
 */

import { SpanStatus } from "@traceroot/core";
import type { Span } from "@/types/api";
import {
  compareSpansForStableDisplay,
  parseTimestamp,
  spanMetadataPaths,
} from "@/features/traces/utils";
import { lcsAlign } from "./line-diff";

/**
 * How a pair was made: `path` — same kind and logical path below the paired roots;
 * `root` — the only root of each trace, paired although its name or kind differs.
 */
export type MatchBasis = "path" | "root";

export interface MatchReason {
  basis: MatchBasis;
  /** The baseline span's logical path, root → span names. */
  path: string[];
  /** The baseline span's kind; kind is part of what the matcher compares. */
  spanKind: Span["span_kind"];
  /** 1-based position among siblings of the same kind and name, on each side. */
  ordinal: { baseline: number; candidate: number };
  /**
   * Set when the span ran at the same time as other siblings of its kind and name (on
   * either side): how many ran together, on the side with more. Such calls pair in
   * start order.
   */
  parallel?: number;
  /**
   * Set when the candidate span ran under a different parent than the one its pair is
   * drawn under (its parent was left unmatched): that parent's name and ordinal, or null
   * when it sits at the top level.
   */
  candidateParent?: { name: string; ordinal: number } | null;
}

export interface SpanPair {
  baseline: Span;
  candidate: Span;
  reason: MatchReason;
}

export interface SpanMatch {
  pairs: SpanPair[];
  byBaselineId: ReadonlyMap<string, SpanPair>;
  byCandidateId: ReadonlyMap<string, SpanPair>;
  /** Candidate spans with no baseline counterpart, in display order. */
  added: Span[];
  /** Baseline spans with no candidate counterpart, in display order. */
  removed: Span[];
  /** Each side's children by parent span id, in display order (top level under null). */
  baselineChildren: ReadonlyMap<string | null, Span[]>;
  candidateChildren: ReadonlyMap<string | null, Span[]>;
}

// Joins key segments so ["ab", "c"] and ["a", "bc"] cannot collide.
const SEP = "\u001f";
// Above this many LCS cells (one sibling list against another) the table costs more
// memory than the alignment is worth; such lists pair by key in order instead, which
// also goes front to back.
const MAX_LCS_CELLS = 1_000_000;

const leafKey = (s: Span) => `${s.span_kind}${SEP}${s.name}`;

/** Children by parent id of spans already in display order. A span whose parent is not in
 *  the trace sits at the top level (key null) beside the root, as the trace tree shows it. */
function groupChildren(sorted: readonly Span[]): Map<string | null, Span[]> {
  const ids = new Set(sorted.map((s) => s.span_id));
  const children = new Map<string | null, Span[]>();
  for (const s of sorted) {
    // Ingest sometimes stores a root's parent as "" rather than null.
    const parent = s.parent_span_id && ids.has(s.parent_span_id) ? s.parent_span_id : null;
    const list = children.get(parent);
    if (list) list.push(s);
    else children.set(parent, [s]);
  }
  return children;
}

function recordedPath(span: Span): string[] | null {
  const { namePath } = spanMetadataPaths(span);
  return Array.isArray(namePath) &&
    namePath.length > 0 &&
    namePath.every((v) => typeof v === "string")
    ? namePath
    : null;
}

interface Side {
  /** Display order. */
  spans: Span[];
  byId: Map<string, Span>;
  children: Map<string | null, Span[]>;
  /** Parent span id, or null at the top level (a parent not in the trace included). */
  parent: Map<string, string | null>;
  path: Map<string, string[]>;
  ordinal: Map<string, number>;
  /** How many siblings of the same kind and name ran at once with the span, itself
   *  included. */
  parallel: Map<string, number>;
  /** The span's subtree (kind, name and children, recursively) as an id that is equal
   *  across both sides exactly when the structure is. */
  shape: Map<string, number>;
}

/** Splits siblings into runs of the same key (kind and name unless told), in order. */
function byKey(siblings: readonly Span[], key = leafKey): Map<string, Span[]> {
  const groups = new Map<string, Span[]>();
  for (const s of siblings) {
    const list = groups.get(key(s));
    if (list) list.push(s);
    else groups.set(key(s), [s]);
  }
  return groups;
}

/**
 * The key two sibling lists align on: kind and name, except that a placeholder for a span
 * that hasn't arrived yet carries a generic kind, so it and the siblings sharing its name
 * match by name alone.
 */
function alignmentKey(bases: readonly Span[], cands: readonly Span[]): (s: Span) => string {
  const loose = new Set([...bases, ...cands].filter((s) => s.pending).map((s) => s.name));
  if (loose.size === 0) return leafKey;
  return (s) => (loose.has(s.name) ? `${SEP}${s.name}` : leafKey(s));
}

/** `shapes` is shared by both sides, so equal subtrees get equal ids. */
function indexSide(spans: readonly Span[], shapes: Map<string, number>): Side {
  const sorted = [...spans].sort(compareSpansForStableDisplay);
  const children = groupChildren(sorted);
  const byId = new Map(sorted.map((s) => [s.span_id, s]));
  const parent = new Map<string, string | null>();
  for (const [p, kids] of children) for (const k of kids) parent.set(k.span_id, p);

  const ordinal = new Map<string, number>();
  const parallel = new Map<string, number>();
  for (const siblings of children.values()) {
    for (const group of byKey(siblings).values()) {
      group.forEach((s, i) => ordinal.set(s.span_id, i + 1));
      // A run of same-key siblings each starting before the run so far has ended. A span
      // still running has no end, so it overlaps every later one.
      let run: Span[] = [];
      let runEnd = -Infinity;
      const close = () => run.forEach((s) => parallel.set(s.span_id, run.length));
      for (const s of group) {
        if (run.length > 0 && parseTimestamp(s.span_start_time) >= runEnd) {
          close();
          run = [];
          runEnd = -Infinity;
        }
        run.push(s);
        const end = s.span_end_time ? parseTimestamp(s.span_end_time) : Infinity;
        runEnd = Math.max(runEnd, end);
      }
      close();
    }
  }

  const derivedPath = (span: Span): string[] => {
    const names: string[] = [];
    const visited = new Set<string>();
    let cur: Span | undefined = span;
    // The visited set stops a parent cycle in malformed data.
    while (cur && !visited.has(cur.span_id)) {
      visited.add(cur.span_id);
      names.push(cur.name);
      cur = cur.parent_span_id ? byId.get(cur.parent_span_id) : undefined;
    }
    return names.reverse();
  };
  const path = new Map(sorted.map((s) => [s.span_id, recordedPath(s) ?? derivedPath(s)]));

  const shape = new Map<string, number>();
  const visiting = new Set<string>();
  const shapeOf = (s: Span): number => {
    const known = shape.get(s.span_id);
    if (known !== undefined) return known;
    // Only a parent cycle in malformed data comes back to a span being shaped.
    if (visiting.has(s.span_id)) return -1;
    visiting.add(s.span_id);
    const key = `${leafKey(s)}(${(children.get(s.span_id) ?? []).map(shapeOf).join(",")})`;
    visiting.delete(s.span_id);
    let id = shapes.get(key);
    if (id === undefined) {
      id = shapes.size;
      shapes.set(key, id);
    }
    shape.set(s.span_id, id);
    return id;
  };
  sorted.forEach(shapeOf);

  return { spans: sorted, byId, children, parent, path, ordinal, parallel, shape };
}

/** Pair entries with equal keys in occurrence order (the k-th with the k-th). */
function pairByKey(
  bases: Span[],
  cands: Span[],
  baseKey: (s: Span) => string,
  candKey: (s: Span) => string,
): Array<[Span, Span]> {
  const byKeyIndex = byKey(bases, baseKey);
  const taken = new Map<string, number>();
  const pairs: Array<[Span, Span]> = [];
  for (const c of cands) {
    const key = candKey(c);
    const i = taken.get(key) ?? 0;
    const b = byKeyIndex.get(key)?.[i];
    if (b) {
      taken.set(key, i + 1);
      pairs.push([b, c]);
    }
  }
  return pairs;
}

const failed = (s: Span) => s.status === SpanStatus.ERROR;

/**
 * Attempts the data shows were retried, which step aside so the later attempts align.
 * Only the side that ran a step more often gives any up, and never more than its surplus:
 *   · a failed attempt with another of the same step after it, as many as this side
 *     failed more often than the other;
 *   · then an attempt whose subtree the other side never ran, while a later attempt's
 *     subtree it did.
 */
function retriedAttempts(
  bases: Span[],
  cands: Span[],
  base: Side,
  cand: Side,
  keyOf: (s: Span) => string,
): Set<Span> {
  const set = new Set<Span>();
  const candGroups = byKey(cands, keyOf);
  for (const [key, bs] of byKey(bases, keyOf)) {
    const cs = candGroups.get(key);
    if (!cs || cs.length === bs.length) continue;
    const [more, fewer, moreSide, fewerSide] =
      bs.length > cs.length ? [bs, cs, base, cand] : [cs, bs, cand, base];
    let surplus = more.length - fewer.length;

    const retried = (list: Span[]) => list.filter((s, i) => failed(s) && i < list.length - 1);
    const moreRetried = retried(more);
    const extraFailures = moreRetried.length - retried(fewer).length;
    for (const s of moreRetried.slice(0, Math.max(0, Math.min(surplus, extraFailures)))) {
      set.add(s);
      surplus--;
    }
    if (surplus === 0) continue;

    const otherShapes = new Set(fewer.map((s) => fewerSide.shape.get(s.span_id)));
    const kept = more.filter((s) => !set.has(s));
    const known = kept.map((s) => otherShapes.has(moreSide.shape.get(s.span_id)!));
    const knownLater = new Array<boolean>(kept.length).fill(false);
    for (let i = kept.length - 2; i >= 0; i--) knownLater[i] = known[i + 1] || knownLater[i + 1];
    for (let i = 0; i < kept.length && surplus > 0; i++) {
      if (!known[i] && knownLater[i]) {
        set.add(kept[i]);
        surplus--;
      }
    }
  }
  return set;
}

function alignSiblings(bases: Span[], cands: Span[], base: Side, cand: Side): Array<[Span, Span]> {
  if (bases.length === 0 || cands.length === 0) return [];
  const keyOf = alignmentKey(bases, cands);
  const retried = retriedAttempts(bases, cands, base, cand, keyOf);
  const keptBases = bases.filter((s) => !retried.has(s));
  const keptCands = cands.filter((s) => !retried.has(s));
  const aligned = lcsAlign(keptBases.map(keyOf), keptCands.map(keyOf), MAX_LCS_CELLS);
  const pairs: Array<[Span, Span]> =
    aligned === null
      ? pairByKey(keptBases, keptCands, keyOf, keyOf)
      : aligned.map(([bi, ci]) => [keptBases[bi], keptCands[ci]]);
  // LCS keeps order, so a reordered sibling is skipped; pair those by key, with the
  // retried attempts last.
  const pairedBase = new Set(pairs.map(([b]) => b));
  const pairedCand = new Set(pairs.map(([, c]) => c));
  const rest = (list: Span[], paired: Set<Span>) => [
    ...list.filter((s) => !paired.has(s) && !retried.has(s)),
    ...list.filter((s) => retried.has(s)),
  ];
  return [...pairs, ...pairByKey(rest(bases, pairedBase), rest(cands, pairedCand), keyOf, keyOf)];
}

export function matchSpans(baseline: readonly Span[], candidate: readonly Span[]): SpanMatch {
  const shapes = new Map<string, number>();
  const base = indexSide(baseline, shapes);
  const cand = indexSide(candidate, shapes);
  const pairs: SpanPair[] = [];
  const byBaselineId = new Map<string, SpanPair>();
  const byCandidateId = new Map<string, SpanPair>();

  const record = (b: Span, c: Span, basis: MatchBasis): SpanPair => {
    const parallel = Math.max(base.parallel.get(b.span_id)!, cand.parallel.get(c.span_id)!);
    const pair: SpanPair = {
      baseline: b,
      candidate: c,
      reason: {
        basis,
        path: base.path.get(b.span_id)!,
        spanKind: b.span_kind,
        ordinal: {
          baseline: base.ordinal.get(b.span_id)!,
          candidate: cand.ordinal.get(c.span_id)!,
        },
        ...(parallel > 1 && { parallel }),
      },
    };
    pairs.push(pair);
    byBaselineId.set(b.span_id, pair);
    byCandidateId.set(c.span_id, pair);
    return pair;
  };

  // Each sibling list is reached once, through its parent's pair, so nothing here can
  // be matched twice.
  const walk = (bases: Span[], cands: Span[]) => {
    for (const [b, c] of alignSiblings(bases, cands, base, cand)) {
      record(b, c, "path");
      walk(base.children.get(b.span_id) ?? [], cand.children.get(c.span_id) ?? []);
    }
  };

  const baseTop = base.children.get(null) ?? [];
  const candTop = cand.children.get(null) ?? [];
  const rootsPaired = baseTop.length === 1 && candTop.length === 1;
  if (rootsPaired) {
    const [b] = baseTop;
    const [c] = candTop;
    // A placeholder root has a generic kind; its name is what it knows.
    const same = b.name === c.name && (b.pending || c.pending || b.span_kind === c.span_kind);
    record(b, c, same ? "path" : "root");
    walk(base.children.get(b.span_id) ?? [], cand.children.get(c.span_id) ?? []);
  } else {
    walk(baseTop, candTop);
  }

  // Paired roots may be named differently, so paths compare below them. The root
  // segment is dropped only when it is that root's name, never leaving a bare kind.
  const pathKey = (side: Side, root: Span | undefined) => (s: Span) => {
    const path = side.path.get(s.span_id)!;
    const below = root && path.length > 1 && path[0] === root.name ? path.slice(1) : path;
    return `${s.span_kind}${SEP}${below.join(SEP)}`;
  };
  const stranded = pairByKey(
    base.spans.filter((s) => !byBaselineId.has(s.span_id)),
    cand.spans.filter((s) => !byCandidateId.has(s.span_id)),
    pathKey(base, rootsPaired ? baseTop[0] : undefined),
    pathKey(cand, rootsPaired ? candTop[0] : undefined),
  ).map(([b, c]) => record(b, c, "path"));

  // A stranded pair is drawn under the baseline span's parent; say where the candidate
  // span ran when that is somewhere else.
  for (const pair of stranded) {
    const baseParent = base.parent.get(pair.baseline.span_id) ?? null;
    const candParent = cand.parent.get(pair.candidate.span_id) ?? null;
    const drawnUnder = baseParent === null ? null : byBaselineId.get(baseParent)?.candidate.span_id;
    if (drawnUnder === candParent) continue;
    pair.reason.candidateParent =
      candParent === null
        ? null
        : { name: cand.byId.get(candParent)!.name, ordinal: cand.ordinal.get(candParent)! };
  }

  return {
    pairs,
    byBaselineId,
    byCandidateId,
    added: cand.spans.filter((s) => !byCandidateId.has(s.span_id)),
    removed: base.spans.filter((s) => !byBaselineId.has(s.span_id)),
    baselineChildren: base.children,
    candidateChildren: cand.children,
  };
}

/**
 * One-line reason for a pair, e.g. "Matched by path: agent › tool:web_search #2", with
 * a note when same-named calls ran in parallel or the candidate span ran elsewhere.
 */
export function describeMatchReason(reason: MatchReason): string {
  if (reason.basis === "root") return "Matched as the trace root";
  const name = reason.path[reason.path.length - 1];
  const leaf = `${reason.spanKind.toLowerCase()}:${name}`;
  const { baseline, candidate } = reason.ordinal;
  const ordinal = baseline === candidate ? `#${baseline}` : `#${baseline} → #${candidate}`;
  const parts = [`Matched by path: ${[...reason.path.slice(0, -1), leaf].join(" › ")} ${ordinal}`];
  if (reason.parallel) {
    parts.push(`one of ${reason.parallel} parallel ${name} calls, paired by start order`);
  }
  if (reason.candidateParent !== undefined) {
    parts.push(
      reason.candidateParent === null
        ? "in the candidate it sits at the top level"
        : `in the candidate it sits under ${reason.candidateParent.name} #${reason.candidateParent.ordinal}`,
    );
  }
  return parts.join(" · ");
}
