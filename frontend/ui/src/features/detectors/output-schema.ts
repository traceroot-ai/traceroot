/**
 * Detector output-schema validation. Each entry becomes a field of the
 * detection worker's submit_result tool
 * (frontend/worker/src/detection/submit-result-tool.ts), so the write path
 * refuses what the worker cannot use: an unknown type would be screened as a
 * string, a repeated name keeps only the last declaration, a reserved name is
 * dropped, and an entry without a name is skipped.
 */
import {
  OUTPUT_FIELD_TYPES,
  RESERVED_FIELD_NAMES,
  isUsableFieldName,
} from "@traceroot/core/detector-output-schema";
import { isPlainObject } from "@/lib/is-plain-object";

function fieldError(item: unknown, index: number, seen: Set<string>): string | null {
  const at = `output field ${index + 1}`;
  if (!isPlainObject(item)) return `${at} must be an object`;
  const { name, type } = item;
  if (typeof name === "string" && RESERVED_FIELD_NAMES.has(name)) {
    return `${at} name ${JSON.stringify(name)} is reserved`;
  }
  if (!isUsableFieldName(name)) return `${at} requires a non-empty name`;
  if (!OUTPUT_FIELD_TYPES.some((known) => known === type)) {
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
