/**
 * The union of two traces of the same case, laid out as one tree for the trace diff.
 *
 * The baseline is the skeleton: matched and removed spans keep the baseline's nesting
 * and sibling order. Each added span is grafted under the node of its candidate parent
 * (so a new subtree stays intact), just before the next sibling both runs share, or
 * last when none follows. A replaced span therefore reads removed, then added.
 */

import type { Span, TraceDetail } from "@/types/api";
import { enrichSpansWithPending, getSpanDuration } from "@/features/traces/utils";
import { matchSpans, type MatchReason } from "./span-match";
import { attributionOf, spanTotalTokens } from "./trace-usage";

/** One metric on each side of a node; null when that side has no span or no value. */
export interface MetricPair {
  baseline: number | null;
  candidate: number | null;
}

export interface UnionNodeMetrics {
  durationMs: MetricPair;
  totalTokens: MetricPair;
  cost: MetricPair;
}

type UnionEntry =
  | { state: "matched"; baseline: Span; candidate: Span; reason: MatchReason }
  | { state: "added"; baseline: null; candidate: Span; reason: null }
  | { state: "removed"; baseline: Span; candidate: null; reason: null };

export type UnionNode = UnionEntry & {
  /** `baseline:<span_id>` for matched and removed nodes, `candidate:<span_id>` for added. */
  id: string;
  parentId: string | null;
  /** Depth and connector lines, as SpanTreeConnector takes them. */
  level: number;
  isTerminal: boolean;
  parentLevels: number[];
  /**
   * A span of an evaluation's scorer (an LLM judge's calls, say), not of the run under
   * test: the scorer span itself and everything under it.
   */
  evaluator: boolean;
  /**
   * Added or removed; or matched with a different status, model, token total or cost, a
   * duration that moved by half and by at least 100ms, a renamed root, or a candidate span
   * that ran under another parent than the one it is drawn under. Never an evaluator
   * span: a judge's usage follows the output it judged.
   */
  changed: boolean;
  metrics: UnionNodeMetrics;
};

export type UnionNodeState = UnionNode["state"];

export interface UnionTreeCounts {
  matched: number;
  added: number;
  removed: number;
  /** matched + added + removed: every node in the union. */
  total: number;
}

export interface UnionTree {
  /** Depth-first, parents before children. */
  nodes: UnionNode[];
  counts: UnionTreeCounts;
}

function durationMs(span: Span): number | null {
  // A span still running has no duration to compare yet (the viewer would measure it
  // against now).
  if (!span.span_end_time) return null;
  const ms = getSpanDuration(span);
  return ms !== null && Number.isFinite(ms) ? ms : null;
}

function metricsOf({ baseline, candidate }: UnionEntry): UnionNodeMetrics {
  const pair = (read: (s: Span) => number | null): MetricPair => ({
    baseline: baseline ? read(baseline) : null,
    candidate: candidate ? read(candidate) : null,
  });
  return {
    durationMs: pair(durationMs),
    totalTokens: pair(spanTotalTokens),
    // A streamed span with no usage lacks the key rather than holding null.
    cost: pair((s) => s.cost ?? null),
  };
}

// Costs are summed per-token prices, so equal spend can differ in the last float bits.
export const COST_EPSILON = 1e-9;

function costDiffers(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) >= COST_EPSILON;
}

// Durations jitter run to run; only a move by half and by at least 100ms is a change.
export const DURATION_CHANGE_RATIO = 0.5;
export const DURATION_CHANGE_MIN_MS = 100;

function durationDiffers({ baseline, candidate }: MetricPair): boolean {
  if (baseline === null || candidate === null) return false;
  const delta = Math.abs(candidate - baseline);
  return delta >= DURATION_CHANGE_MIN_MS && delta >= DURATION_CHANGE_RATIO * baseline;
}

function isChanged(entry: UnionEntry, metrics: UnionNodeMetrics): boolean {
  if (entry.state !== "matched") return true;
  const { baseline: b, candidate: c, reason } = entry;
  // A placeholder for a span that hasn't arrived has nothing to compare yet.
  if (b.pending || c.pending) return false;
  return (
    reason.basis === "root" ||
    reason.candidateParent !== undefined ||
    b.status !== c.status ||
    (b.model_name ?? null) !== (c.model_name ?? null) ||
    spanTotalTokens(b) !== spanTotalTokens(c) ||
    costDiffers(metrics.cost.baseline, metrics.cost.candidate) ||
    durationDiffers(metrics.durationMs)
  );
}

// Namespaced so an added span can never collide with a baseline span of the same id.
const idOf = (entry: UnionEntry) =>
  entry.baseline ? `baseline:${entry.baseline.span_id}` : `candidate:${entry.candidate.span_id}`;

export function buildUnionTree(baseline: readonly Span[], candidate: readonly Span[]): UnionTree {
  const match = matchSpans(baseline, candidate);
  const baseKids = match.baselineChildren;
  const candKids = match.candidateChildren;
  const baseById = new Map(baseline.map((s) => [s.span_id, s]));
  const candById = new Map(candidate.map((s) => [s.span_id, s]));
  // Same rule as the run's usage split: under a SCORER is the evaluation's.
  const scoredOn = ({ baseline: b, candidate: c }: UnionEntry) =>
    (b !== null && attributionOf(b, baseById) === "scorer") ||
    (c !== null && attributionOf(c, candById) === "scorer");

  const skeleton = (b: Span): UnionEntry => {
    const pair = match.byBaselineId.get(b.span_id);
    return pair
      ? { state: "matched", baseline: b, candidate: pair.candidate, reason: pair.reason }
      : { state: "removed", baseline: b, candidate: null, reason: null };
  };
  const graft = (c: Span): UnionEntry => ({
    state: "added",
    baseline: null,
    candidate: c,
    reason: null,
  });

  // A side with no span at this node (key undefined) contributes no children.
  const kids = (byParent: ReadonlyMap<string | null, Span[]>, key: string | null | undefined) =>
    key === undefined ? [] : (byParent.get(key) ?? []);

  /** Children of a union node (null = the top level) in display order. */
  const childrenOf = (parent: UnionEntry | null): UnionEntry[] => {
    const backbone = kids(baseKids, parent ? parent.baseline?.span_id : null);
    const cands = kids(candKids, parent ? parent.candidate?.span_id : null);
    const inBackbone = new Set(backbone.map((b) => b.span_id));
    // Added spans wait for the next candidate sibling that is matched into this backbone,
    // and go just before it.
    const before = new Map<string, Span[]>();
    let waiting: Span[] = [];
    for (const c of cands) {
      const pair = match.byCandidateId.get(c.span_id);
      if (!pair) waiting.push(c);
      else if (waiting.length > 0 && inBackbone.has(pair.baseline.span_id)) {
        before.set(pair.baseline.span_id, waiting);
        waiting = [];
      }
    }
    return [
      ...backbone.flatMap((b) => [...(before.get(b.span_id) ?? []).map(graft), skeleton(b)]),
      ...waiting.map(graft),
    ];
  };

  const nodes: UnionNode[] = [];
  const placed = new Set<string>();
  const place = (
    entry: UnionEntry,
    parentId: string | null,
    level: number,
    isTerminal: boolean,
    parentLevels: number[],
    underEvaluator: boolean,
  ) => {
    const id = idOf(entry);
    // Only a parent cycle in malformed data can reach a node twice.
    if (placed.has(id)) return;
    placed.add(id);
    // Everything drawn under an evaluator span is one too, so hiding them hides whole
    // subtrees.
    const evaluator = underEvaluator || scoredOn(entry);
    const metrics = metricsOf(entry);
    nodes.push({
      ...entry,
      id,
      parentId,
      level,
      isTerminal,
      parentLevels,
      evaluator,
      changed: !evaluator && isChanged(entry, metrics),
      metrics,
    });
    const children = childrenOf(entry);
    children.forEach((kid, i) => {
      const last = i === children.length - 1;
      place(kid, id, level + 1, last, last ? parentLevels : [...parentLevels, level], evaluator);
    });
  };

  const top = childrenOf(null);
  top.forEach((entry, i) => place(entry, null, 0, i === top.length - 1, [], false));
  // Spans in a parent cycle are unreachable from the top; list them there rather than
  // drop them, so the counts always match the rows.
  for (const entry of [
    ...match.pairs.map((p) => skeleton(p.baseline)),
    ...match.removed.map(skeleton),
    ...match.added.map(graft),
  ]) {
    place(entry, null, 0, true, [], false);
  }

  const counts: UnionTreeCounts = { matched: 0, added: 0, removed: 0, total: nodes.length };
  for (const n of nodes) counts[n.state]++;
  return { nodes, counts };
}

/** A streamed span with no usage arrives without the usage keys; read them as null. */
const withUsageKeys = (s: Span): Span => ({
  ...s,
  model_name: s.model_name ?? null,
  cost: s.cost ?? null,
  input_tokens: s.input_tokens ?? null,
  output_tokens: s.output_tokens ?? null,
  total_tokens: s.total_tokens ?? null,
});

/** A trace's spans as the trace viewer draws them: a placeholder for every ancestor that
 *  hasn't arrived. */
const arrivedSpans = (trace: TraceDetail) => enrichSpansWithPending(trace.spans.map(withUsageKeys));

/** Two traces of the same case as one tree, both shaped the way the trace viewer shows
 *  them. */
export function traceUnion(baseline: TraceDetail, candidate: TraceDetail): UnionTree {
  return buildUnionTree(arrivedSpans(baseline), arrivedSpans(candidate));
}

/** How the run under test's spans diverge: an evaluation's scorer spans are left out, as
 *  they follow the output they judged rather than the run. */
export function divergenceCounts(
  nodes: readonly UnionNode[],
): Pick<UnionTreeCounts, "matched" | "added" | "removed"> {
  const counts = { matched: 0, added: 0, removed: 0 };
  for (const n of nodes) if (!n.evaluator) counts[n.state]++;
  return counts;
}

/** The nodes left to show when the nodes in `collapsed` (by id) hide what is under them;
 *  tree order kept. */
export function visibleUnionNodes(
  nodes: readonly UnionNode[],
  collapsed: ReadonlySet<string>,
): UnionNode[] {
  if (collapsed.size === 0) return nodes as UnionNode[];
  const hidden = new Set<string>();
  return nodes.filter((n) => {
    // Parents come first, so a hidden parent is already known.
    if (n.parentId !== null && (hidden.has(n.parentId) || collapsed.has(n.parentId))) {
      hidden.add(n.id);
      return false;
    }
    return true;
  });
}

/** The ids of the nodes that have children. */
export function unionParentIds(nodes: readonly UnionNode[]): Set<string> {
  const ids = new Set<string>();
  for (const n of nodes) if (n.parentId !== null) ids.add(n.parentId);
  return ids;
}

/** The span a node shows: this trace's, or the baseline's when only the baseline has it. */
export function unionNodeSpan(node: UnionNode): Span {
  return node.candidate ?? node.baseline;
}

/** A node's name; a root paired across a rename reads "old → new". */
export function unionNodeName(node: UnionNode): string {
  if (node.state === "matched" && node.baseline.name !== node.candidate.name) {
    return `${node.baseline.name} → ${node.candidate.name}`;
  }
  return unionNodeSpan(node).name;
}

/** Whether a matched span ran under another parent in the candidate than the one it is
 *  drawn under. */
export const isMovedNode = (node: UnionNode) =>
  node.state === "matched" && node.reason.candidateParent !== undefined;

/**
 * Which way a metric moved from baseline to candidate, lower being better for all three;
 * null when either side is unknown or it didn't move enough to count (duration by the
 * same rule `changed` uses, so run-to-run jitter reads as no change).
 */
export function metricDirection(
  key: keyof UnionNodeMetrics,
  pair: MetricPair,
): "better" | "worse" | null {
  const { baseline, candidate } = pair;
  if (baseline === null || candidate === null) return null;
  const moved =
    key === "durationMs"
      ? durationDiffers(pair)
      : key === "cost"
        ? costDiffers(baseline, candidate)
        : baseline !== candidate;
  if (!moved) return null;
  return candidate < baseline ? "better" : "worse";
}
