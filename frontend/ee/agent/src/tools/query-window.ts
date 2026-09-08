import { REGISTRY } from "@traceroot-ai/tools";

/**
 * The window a dashboard read is answered for, as the messages route accepts
 * it from the page: the site's selected range for the project (a preset id)
 * or, for the picker's custom option, explicit bounds. Travels with each
 * message because the picker can change between two messages in one session.
 */
export interface QueryWindow {
  range?: string;
  start_time?: string;
  end_time?: string;
}

const RANGE_IDS: ReadonlySet<string> = new Set(
  // The registry entry's enum is the server's preset table as generated into
  // the tool schema — the same list the model sees, so a mirror would drift.
  (
    REGISTRY.find((entry) => entry.name === "run_widget_query")?.inputSchema.properties.range as
      | { enum?: string[] }
      | undefined
  )?.enum ?? [],
);

/** Whether a page-supplied window is well-formed: one preset id, or both bounds as ISO dates. */
export function parseQueryWindow(input: unknown): QueryWindow | undefined | Error {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object") return new Error("window must be an object");
  const { range, start_time, end_time } = input as Record<string, unknown>;
  const hasRange = range !== undefined && range !== null;
  const hasBounds = (start_time ?? null) !== null || (end_time ?? null) !== null;
  if (hasRange && hasBounds) return new Error("give either range or start_time/end_time, not both");
  if (hasRange) {
    if (typeof range !== "string" || !RANGE_IDS.has(range)) {
      return new Error(`unknown range: ${String(range)}`);
    }
    return { range };
  }
  if (hasBounds) {
    if (typeof start_time !== "string" || typeof end_time !== "string") {
      return new Error("both start_time and end_time are required together");
    }
    const start = Date.parse(start_time);
    const end = Date.parse(end_time);
    if (Number.isNaN(start) || Number.isNaN(end))
      return new Error("start_time/end_time must be ISO dates");
    if (end <= start) return new Error("end_time must be after start_time");
    return { start_time, end_time };
  }
  return undefined;
}

/**
 * The per-call defaults for a dashboard read tool: the page's window, unless
 * the model named one itself. Any window param from the model — a range or
 * either bound — means the user asked, and the page's picker stands down;
 * merging the two would be a request the server rightly rejects.
 */
export function windowDefaults(window: QueryWindow | undefined) {
  return (supplied: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    if (window === undefined) return {};
    if ("range" in supplied || "start_time" in supplied || "end_time" in supplied) return {};
    return { ...window };
  };
}
