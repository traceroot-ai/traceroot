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
    .map((group) => group.trim());
  const allowed = new Set(requested.flatMap((group) => CONTENT_GROUPS[group] ?? []));
  const kept: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const field of CONTENT_FIELDS) {
    if (!allowed.has(field)) {
      delete kept[field];
    }
  }
  return kept;
}
