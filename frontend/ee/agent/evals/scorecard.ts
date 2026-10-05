import type { ScenarioResult } from "./types.js";

/** Keeps one failure per line so the table stays scannable in a terminal. */
const MAX_ERROR_CHARS = 80;

function truncate(text: string): string {
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatScorecard(results: ScenarioResult[]): string {
  const nameWidth = Math.max(8, ...results.map((result) => result.name.length));
  const rows = results.map((result) =>
    [
      result.name.padEnd(nameWidth),
      result.passed ? "PASS" : "FAIL",
      formatDuration(result.durationMs).padStart(6),
      truncate(result.error ?? ""),
    ]
      .join("  ")
      .trimEnd(),
  );

  const passed = results.filter((result) => result.passed).length;
  return [...rows, `${passed}/${results.length} scenarios passed`].join("\n");
}

/** An empty run proves nothing, so it is not a pass. */
export function allPassed(results: ScenarioResult[]): boolean {
  return results.length > 0 && results.every((result) => result.passed);
}
