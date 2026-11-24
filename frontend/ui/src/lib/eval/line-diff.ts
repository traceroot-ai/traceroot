/**
 * A small, dependency-free line diff (LCS) for showing two eval outputs git-style:
 * `remove` lines are only in the first (old) value, `add` lines only in the second (new),
 * `context` lines in both. Callers show and diff each value as `normalizeForDiff` gives
 * it, so a structured output diffs line by line and a pure reformat is no diff at all.
 * The diff itself never decodes: decoding twice would turn the string "1.50" into 1.5.
 * `markChangedWords` then marks the words that changed inside each changed line.
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
 * scalar as JSON. Text that isn't JSON, or nests too deep to indent, is returned
 * unchanged.
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
  try {
    // `canonicalJson` sorts the keys, and parsing it back keeps that order for the indent,
    // except that integer-like keys ("2", "10") come first, in numeric order, as in any
    // object. Every value takes the same steps, so two that differ only in key order
    // still read the same.
    return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);
  } catch {
    // Indenting recurses, so a value nested deeper than the call stack allows can't be
    // indented; showing it as stored keeps the page up.
    return text;
  }
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

/** A word, a run of whitespace, or any other character (punctuation) on its own. */
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/**
 * Comparing two lines word by word is O(m·n) in the tokens between what they share at
 * either end. Past this many cells over one diff, the pairs left keep their whole-line
 * marking, so a very long changed line can't freeze the tab.
 */
const WORD_CELL_BUDGET = 2_000_000;

/** Which of `a`'s and `b`'s tokens are not in their longest common subsequence; null when
 *  that would cost more than the budget left. */
function changedTokens(
  a: readonly string[],
  b: readonly string[],
  budget: { cells: number },
): [boolean[], boolean[]] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  // The middle's alignment, as the line diff aligns lines.
  const pairs = lcsAlign(a.slice(start, endA), b.slice(start, endB), budget.cells);
  if (!pairs) return null;
  budget.cells -= (endA - start) * (endB - start);

  const changedA = a.map((_, i) => i >= start && i < endA);
  const changedB = b.map((_, j) => j >= start && j < endB);
  for (const [i, j] of pairs) {
    changedA[start + i] = false;
    changedB[start + j] = false;
  }
  return [changedA, changedB];
}

/** A line's tokens as segments: neighbours with the same marking joined, and a space
 *  between two changed words marked with them, so a changed phrase reads as one. */
function segmentsOf(tokens: readonly string[], changed: readonly boolean[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  tokens.forEach((text, k) => {
    const isChanged =
      changed[k] || (!/\S/.test(text) && changed[k - 1] === true && changed[k + 1] === true);
    const last = segments[segments.length - 1];
    if (last && last.changed === isChanged) last.text += text;
    else segments.push({ text, changed: isChanged });
  });
  return segments;
}

/**
 * The diff with the words that changed marked inside changed lines. In each changed
 * stretch the k-th removed line is compared with the k-th added one, the two `sideBySide`
 * puts on one row. A line with no counterpart, with nothing but spaces in common with it,
 * or past the work budget keeps its whole-line marking (no `segments`).
 */
export function markChangedWords(lines: readonly DiffLine[]): DiffLine[] {
  const marked = [...lines];
  const budget = { cells: WORD_CELL_BUDGET };
  let removed: number[] = [];
  let added: number[] = [];
  const flush = () => {
    for (let k = 0; k < Math.min(removed.length, added.length); k++) {
      const before = marked[removed[k]];
      const after = marked[added[k]];
      const a = before.text.match(TOKEN) ?? [];
      const b = after.text.match(TOKEN) ?? [];
      const changed = changedTokens(a, b, budget);
      if (!changed || !a.some((t, i) => !changed[0][i] && /\S/.test(t))) continue;
      marked[removed[k]] = { ...before, segments: segmentsOf(a, changed[0]) };
      marked[added[k]] = { ...after, segments: segmentsOf(b, changed[1]) };
    }
    removed = [];
    added = [];
  };
  lines.forEach((line, i) => {
    if (line.type === "remove") removed.push(i);
    else if (line.type === "add") added.push(i);
    else flush();
  });
  flush();
  return marked;
}
