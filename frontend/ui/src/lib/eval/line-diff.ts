/**
 * A tiny, dependency-free line diff (LCS) for showing candidate-vs-baseline values
 * git-style. `remove` lines are baseline-only, `add` lines are candidate-only, and
 * `context` lines are unchanged. JSON values are pretty-printed first so the diff is
 * line-meaningful instead of one long line.
 */

export type DiffLineType = "context" | "add" | "remove";
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** Pretty-print when the text is JSON, so a structured value diffs line by line. */
export function normalizeForDiff(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      /* not JSON — diff as-is */
    }
  }
  return text;
}

/**
 * Line diff of `baseline` → `candidate` (old → new). O(m·n); intended for the small
 * outputs an eval result holds, not large blobs.
 */
export function diffLines(baseline: string, candidate: string): DiffLine[] {
  const a = normalizeForDiff(baseline).split("\n");
  const b = normalizeForDiff(candidate).split("\n");
  const m = a.length;
  const n = b.length;

  // The LCS table below is O(m·n) in time AND memory. For a very large payload that
  // would freeze the tab or exhaust memory, skip the line-level diff and fall back to
  // a whole-value replace (all of baseline removed, all of candidate added) — bounded
  // and O(m+n). Identical inputs short-circuit to plain context so an unchanged large
  // value doesn't render as a full remove+add.
  const LCS_CELL_CAP = 2_000_000;
  if (m * n > LCS_CELL_CAP) {
    if (m === n && a.every((line, i) => line === b[i])) {
      return a.map((text) => ({ type: "context" as const, text }));
    }
    return [
      ...a.map((text) => ({ type: "remove" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }

  // LCS length table (suffix form), so we can walk forward emitting a stable diff.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "remove", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "remove", text: a[i++] });
  while (j < n) out.push({ type: "add", text: b[j++] });
  return out;
}

/** True when the two values differ once normalized (so a pure reformat isn't a diff). */
export function valuesDiffer(baseline: string, candidate: string): boolean {
  return normalizeForDiff(baseline) !== normalizeForDiff(candidate);
}
