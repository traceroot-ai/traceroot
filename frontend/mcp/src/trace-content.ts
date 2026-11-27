/**
 * A trace read withholds content unless the caller asks for it. The default
 * "skeleton" projection already leaves per-span input and output out, but the
 * trace's own input, output and metadata still come back; a model reading a
 * trace to find the failing span should not pull user content into its context
 * by default.
 */

/** Trace-level fields that carry user content. */
const CONTENT_FIELDS = ["input", "output", "metadata"] as const;

/** Field groups, as the API names them, that opt a caller in to content. */
const CONTENT_GROUPS: Readonly<Record<string, readonly (typeof CONTENT_FIELDS)[number][]>> = {
  io: ["input", "output"],
  metadata: ["metadata"],
  full: CONTENT_FIELDS,
};

/** Default `fields` for a trace read: the lightweight projection. */
export function traceReadDefaults(): Record<string, unknown> {
  return { fields: "skeleton" };
}

/** Drop the trace-level content fields the requested `fields` groups do not include. */
export function withholdTraceContent(
  result: unknown,
  args: Readonly<Record<string, unknown>>,
): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }
  const requested = String(args.fields ?? "")
    .split(",")
    // The API reads group names case-insensitively.
    .map((group) => group.trim().toLowerCase());
  const allowed = new Set(requested.flatMap((group) => CONTENT_GROUPS[group] ?? []));
  const kept: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const field of CONTENT_FIELDS) {
    if (!allowed.has(field)) {
      delete kept[field];
    }
  }
  return kept;
}

/** Trace list fields that carry user content; get_trace returns them for one trace. */
const LIST_CONTENT_FIELDS = ["input", "output", "metadata_map"] as const;

/** Most traces a list_traces call returns when it names no limit. */
export const LIST_TRACES_DEFAULT_LIMIT = 20;

/** Default `limit` for a trace list: fewer rows than the API's own default. */
export function traceListDefaults(): Record<string, unknown> {
  return { limit: LIST_TRACES_DEFAULT_LIMIT };
}

/**
 * Keep each listed trace's summary (ids, name, times, counts, cost, link) and
 * drop its content, so a list stays small enough to scan; the content of one
 * trace comes from get_trace.
 */
export function compactTraceList(result: unknown): unknown {
  if (!isObject(result) || !Array.isArray(result.data)) {
    return result;
  }
  const data = result.data.map((row) => {
    if (!isObject(row)) return row;
    const kept = { ...row };
    for (const field of LIST_CONTENT_FIELDS) delete kept[field];
    return kept;
  });
  return { ...result, data };
}

/** Session trace fields that carry user content; get_trace returns them for one trace. */
const SESSION_CONTENT_FIELDS = ["input", "output", "metadata"] as const;

/**
 * Keep the session's summary and each of its traces' ids, names, times and
 * status, and drop each trace's content, as a trace list does: a long session
 * would otherwise return every turn's full input and output.
 */
export function compactSession(result: unknown): unknown {
  if (!isObject(result) || !Array.isArray(result.traces)) {
    return result;
  }
  const traces = result.traces.map((row) => {
    if (!isObject(row)) return row;
    const kept = { ...row };
    for (const field of SESSION_CONTENT_FIELDS) delete kept[field];
    return kept;
  });
  return { ...result, traces };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
