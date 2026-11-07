/**
 * Detector output-schema validation. Each entry becomes a field of the
 * detection worker's submit_result tool
 * (frontend/worker/src/detection/submit-result-tool.ts), so the write path
 * refuses what the worker cannot use: an unknown type would be screened as a
 * string, a repeated name keeps only the last declaration, a reserved name is
 * dropped, and an entry without a name is skipped.
 */

/** The types the worker builds a tool field for; it reads any other as a string. */
export const OUTPUT_FIELD_TYPES: readonly string[] = ["string", "number", "boolean"];

/** Names the worker drops from the tool (UNSAFE_FIELD_NAMES there; a test keeps the two equal). */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function fieldError(item: unknown, index: number, seen: Set<string>): string | null {
  const at = `output field ${index + 1}`;
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return `${at} must be an object`;
  }
  const { name, type } = item as Record<string, unknown>;
  if (typeof name !== "string" || name.trim().length === 0) {
    return `${at} requires a non-empty name`;
  }
  if (RESERVED_FIELD_NAMES.has(name)) return `${at} name ${JSON.stringify(name)} is reserved`;
  if (typeof type !== "string" || !OUTPUT_FIELD_TYPES.includes(type)) {
    return `${at} type must be one of: ${OUTPUT_FIELD_TYPES.join(", ")}`;
  }
  if (seen.has(name)) return `${at} repeats the name ${JSON.stringify(name)}`;
  seen.add(name);
  return null;
}

/**
 * Validate an output-schema payload at the boundary. Returns the first
 * problem as a human-readable message, or null when the payload is valid.
 * An empty array is valid — the detector then extracts no fields.
 */
export function validateOutputSchema(fields: unknown): string | null {
  if (!Array.isArray(fields)) return "outputSchema must be an array";
  const seen = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const error = fieldError(fields[i], i, seen);
    if (error) return error;
  }
  return null;
}
