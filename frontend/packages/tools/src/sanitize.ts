// The public OpenAPI schema publishes each filterable numeric column's real
// ClickHouse type maximum (int64 / uint64) as a JSON-schema `maximum`. That is
// correct for the API contract but unusable in a model-facing tool schema:
// OpenAI's function-calling API rejects a tool whose parameter schema carries a
// numeric literal that large (400 "a numeric value in the function parameters
// is too large"), while Anthropic accepts it — so the same tools work on Claude
// and 400 on every OpenAI model. No model is going to emit a 9e18 argument
// anyway, so the bound is dropped from the model's view. Small, legitimate
// bounds (e.g. a 1..200 page size) are kept.

const NUMERIC_BOUND_KEYS = new Set([
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "multipleOf",
]);

/**
 * Deep-clone `value` (any JSON-schema fragment), dropping numeric range keywords
 * whose magnitude exceeds the JS safe-integer range, wherever they are nested
 * (object properties, array items, anyOf/oneOf/allOf variants, ...). The input
 * is never mutated: the registry is shared data.
 */
export function stripOversizedNumericBounds<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripOversizedNumericBounds(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        NUMERIC_BOUND_KEYS.has(key) &&
        typeof child === "number" &&
        Math.abs(child) > Number.MAX_SAFE_INTEGER
      ) {
        continue;
      }
      out[key] = stripOversizedNumericBounds(child);
    }
    return out as T;
  }
  return value;
}
