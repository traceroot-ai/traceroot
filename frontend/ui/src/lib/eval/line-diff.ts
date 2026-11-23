/**
 * A small, dependency-free line diff (LCS) for showing two eval outputs git-style:
 * `remove` lines are only in the first (old) value, `add` lines only in the second (new),
 * `context` lines in both. Callers show and diff each value as `normalizeForDiff` gives
 * it, so a structured output diffs line by line and a pure reformat is no diff at all.
 * The diff itself never decodes: decoding twice would turn the string "1.50" into 1.5.
 */
import { canonicalJson, decodeJsonValue } from "./json-value";

export type DiffLineType = "context" | "add" | "remove";
export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** A changed line compared word by word with its counterpart (`markChangedWords`): the
   *  line's text in order, the words that changed marked. */
  segments?: DiffSegment[];
}

/** A stretch of a changed line's text, marked when it is what changed. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DetailedDiff {
  lines: DiffLine[];
  /** True when the outputs were too large to align line by line, so the whole of the
   *  old value is shown removed and the whole of the new one added. */
  truncated: boolean;
}

/** One row of a two-column view: a line of each side, or nothing on the side that has
 *  no counterpart. */
export interface SideBySideRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * The LCS table is O(m·n) in time and memory. Past this many cells a large output would
 * freeze the tab, so the diff falls back to a whole-value replace, which is O(m+n).
 */
const LCS_CELL_CAP = 2_000_000;

const looksStructured = (s: string) => s.startsWith("{") || s.startsWith("[");

/**
 * The text a value is shown and diffed as. A stored output is usually JSON-encoded:
 * a string shows as its text, an object or array as two-space JSON with keys sorted
 * (so key order, spacing and a double-encoded copy all read the same), any other
 * scalar as JSON. Text that isn't JSON is returned unchanged.
 */
export function normalizeForDiff(text: string): string {
  let value = decodeJsonValue(text);
  // Tool output is often stored as a JSON string that itself holds JSON. Two passes at
  // most, so a pathologically nested string can't loop.
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    const inner = value.trim();
    if (!looksStructured(inner)) break;
    const decoded = decodeJsonValue(inner);
    if (decoded === inner) break;
    value = decoded;
  }
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  // `canonicalJson` sorts the keys; parsing it back keeps that order for the indent.
  return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);
}

/**
 * Longest common subsequence of two lists, as `[i, j]` index pairs with `a[i] === b[j]`,
 * front to back. Of the equally long alignments it takes the one that pairs the earliest
 * elements first, so a value repeated more often on one side leaves its last copies
 * over, not its first. Null when `a.length · b.length` is past `maxCells`: the table is
 * O(m·n) in time and memory.
 */
export function lcsAlign<T>(
  a: readonly T[],
  b: readonly T[],
  maxCells: number,
): Array<[number, number]> | null {
  const m = a.length;
  const n = b.length;
  if (m * n > maxCells) return null;
  // LCS lengths of every suffix pair, so the walk below can go front to back.
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Line diff of `before` → `after`, as given (normalize them first). O(m·n), meant for the
 * outputs an eval result holds; past `LCS_CELL_CAP` cells it reports a whole-value replace
 * and `truncated`.
 */
export function diffLinesDetailed(before: string, after: string): DetailedDiff {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const pairs = lcsAlign(a, b, LCS_CELL_CAP);

  if (pairs === null) {
    // An unchanged large value still reads as unchanged, not as a full replace.
    if (a.length === b.length && a.every((line, i) => line === b[i])) {
      return { lines: a.map((text) => ({ type: "context", text })), truncated: false };
    }
    return {
      lines: [
        ...a.map((text) => ({ type: "remove" as const, text })),
        ...b.map((text) => ({ type: "add" as const, text })),
      ],
      truncated: true,
    };
  }

  // Between two shared lines, the old value's lines go first, then the new value's.
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as const]) {
    while (i < pi) lines.push({ type: "remove", text: a[i++] });
    while (j < pj) lines.push({ type: "add", text: b[j++] });
    if (pi < a.length) {
      lines.push({ type: "context", text: a[i++] });
      j++;
    }
  }
  return { lines, truncated: false };
}

/** A diff as two aligned columns: shared lines side by side, and each changed stretch
 *  with its removed lines on the left and added lines on the right, row by row. */
export function sideBySide(lines: readonly DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      rows.push({ left: removed[k] ?? null, right: added[k] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.type === "remove") removed.push(line);
    else if (line.type === "add") added.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}
