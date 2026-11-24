/**
 * How the comparison table is laid out for this viewer: row density, whether long text
 * clips to one line or wraps in full, which columns are hidden, and what a candidate's
 * output marks its changed words against. It is kept per viewer
 * and project in the browser, never in the URL: a shared link names the cases, not
 * someone's layout.
 *
 * The entry can be stale or hand-edited, so a read is never trusted: `normalizeDisplay`
 * keeps each setting it recognises and reads the rest as the default, which is the
 * table's long-standing look.
 */

export type Density = "compact" | "comfortable";
export type TextMode = "clip" | "wrap";
/** What a candidate's output is compared with to mark its changed words. */
export type DiffReference = "baseline" | "expected" | "off";

/** A column the viewer can hide. Input and Run are always shown: they name the case and
 *  each of its lines. */
export type ColumnId = "output" | "expected" | "latency" | "cost" | `metric:${string}`;

export interface DisplayPrefs {
  density: Density;
  text: TextMode;
  /** Columns hidden, rather than shown, so a metric new to the project shows up. A hidden
   *  metric stays hidden in every comparison on the project that has it. */
  hidden: ColumnId[];
  diff: DiffReference;
}

export const DEFAULT_DISPLAY: DisplayPrefs = {
  density: "compact",
  text: "clip",
  hidden: [],
  diff: "baseline",
};

export function displayStorageKey(projectId: string): string {
  return `traceroot:compare-display:${projectId}`;
}

export const metricColumn = (name: string): ColumnId => `metric:${name}`;

const FIXED_COLUMNS: readonly string[] = ["output", "expected", "latency", "cost"];

const isColumnId = (value: unknown): value is ColumnId =>
  typeof value === "string" &&
  (FIXED_COLUMNS.includes(value) || (value.startsWith("metric:") && value.length > 7));

export function normalizeDisplay(stored: unknown): DisplayPrefs {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return DEFAULT_DISPLAY;
  }
  const { density, text, hidden, diff } = stored as Record<string, unknown>;
  return {
    density: density === "comfortable" ? "comfortable" : "compact",
    text: text === "wrap" ? "wrap" : "clip",
    hidden: Array.isArray(hidden) ? [...new Set(hidden.filter(isColumnId))] : [],
    diff: diff === "expected" || diff === "off" ? diff : "baseline",
  };
}

/** The columns the viewer can hide, in the table's order. */
export function columnChoices(scorers: readonly { name: string }[]): {
  id: ColumnId;
  label: string;
}[] {
  return [
    { id: "output", label: "Output" },
    { id: "expected", label: "Expected" },
    ...scorers.map((s) => ({ id: metricColumn(s.name), label: s.name })),
    { id: "latency", label: "Latency" },
    { id: "cost", label: "Cost" },
  ];
}

export const isShown = (display: DisplayPrefs, id: ColumnId): boolean =>
  !display.hidden.includes(id);

/** How many columns the table shows: Input, Run, and every column the viewer hasn't
 *  hidden. */
export const shownColumnCount = (
  display: DisplayPrefs,
  scorers: readonly { name: string }[],
): number => 2 + columnChoices(scorers).filter((c) => isShown(display, c.id)).length;

export function toggleColumn(display: DisplayPrefs, id: ColumnId): DisplayPrefs {
  return {
    ...display,
    hidden: isShown(display, id)
      ? [...display.hidden, id]
      : display.hidden.filter((hidden) => hidden !== id),
  };
}
