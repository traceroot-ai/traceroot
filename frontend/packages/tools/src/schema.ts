const NUMERIC_BOUND_KEYS = new Set(["minimum", "maximum"]);
const SUBSCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SUBSCHEMA_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
  ) as T;
}

function sanitizeSubschema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSubschema(item));
  }
  return isRecord(value) ? sanitizeSchemaObject(value) : value;
}

function sanitizeSubschemaMap(value: unknown): unknown {
  if (!isRecord(value)) {
    return cloneJsonValue(value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, schema]) => [name, sanitizeSubschema(schema)]),
  );
}

function sanitizeSchemaObject(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = Object.entries(value).flatMap(([key, child]) => {
    if (
      NUMERIC_BOUND_KEYS.has(key) &&
      typeof child === "number" &&
      Math.abs(child) > Number.MAX_SAFE_INTEGER
    ) {
      return [];
    }
    if (SUBSCHEMA_MAP_KEYS.has(key)) {
      return [[key, sanitizeSubschemaMap(child)] as const];
    }
    if (SUBSCHEMA_KEYS.has(key)) {
      return [[key, sanitizeSubschema(child)] as const];
    }
    return [[key, cloneJsonValue(child)] as const];
  });
  return Object.fromEntries(sanitized);
}

/** Clone a JSON schema while dropping numeric bounds models cannot represent safely. */
export function sanitizeSchemaForModel<T>(value: T): T {
  return sanitizeSubschema(value) as T;
}
