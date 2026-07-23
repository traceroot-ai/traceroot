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
 * The alignment table is O(m·n) in both time and memory. A pretty-printed blob can
 * turn into tens of thousands of lines per side, so past this size we skip the
 * alignment and fall back to a flat "everything removed, then everything added".
 */
export const MAX_DIFF_CELLS = 2_000_000;

export interface DiffResult {
  lines: DiffLine[];
  /** True when the inputs were too large to align line-by-line, and `lines` is
   *  the flat all-remove/all-add fallback instead of a real LCS diff. */
  truncated: boolean;
}

function computeDiff(baseline: string, candidate: string): DiffResult {
  const a = normalizeForDiff(baseline).split("\n");
  const b = normalizeForDiff(candidate).split("\n");
  const m = a.length;
  const n = b.length;

  if ((m + 1) * (n + 1) > MAX_DIFF_CELLS) {
    return {
      truncated: true,
      lines: [
        ...a.map((text) => ({ type: "remove" as const, text })),
        ...b.map((text) => ({ type: "add" as const, text })),
      ],
    };
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
  return { truncated: false, lines: out };
}

/**
 * Line diff of `baseline` → `candidate` (old → new); intended for the small outputs
 * an eval result holds, not large blobs. See `diffLinesDetailed` when the caller
 * needs to surface the truncation flag.
 */
export function diffLines(baseline: string, candidate: string): DiffLine[] {
  return computeDiff(baseline, candidate).lines;
}

/** Same as `diffLines`, but also reports whether the result was truncated because
 *  the full alignment would have exceeded `MAX_DIFF_CELLS`. */
export function diffLinesDetailed(baseline: string, candidate: string): DiffResult {
  return computeDiff(baseline, candidate);
}

/** True when the two values differ once normalized (so a pure reformat isn't a diff). */
export function valuesDiffer(baseline: string, candidate: string): boolean {
  return normalizeForDiff(baseline) !== normalizeForDiff(candidate);
}
