const NUMERIC_BOUND_KEYS = new Set(["minimum", "maximum"]);

/** Clone a JSON schema while dropping numeric bounds models cannot represent safely. */
export function sanitizeSchemaForModel<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchemaForModel(item)) as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const sanitized = Object.entries(value).flatMap(([key, child]) => {
    if (
      NUMERIC_BOUND_KEYS.has(key) &&
      typeof child === "number" &&
      Math.abs(child) > Number.MAX_SAFE_INTEGER
    ) {
      return [];
    }
    return [[key, sanitizeSchemaForModel(child)] as const];
  });
  return Object.fromEntries(sanitized) as T;
}
