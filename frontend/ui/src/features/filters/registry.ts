/**
 * Frontend filter-field registry: the type mirroring the backend `/filter-fields`
 * payload, plus a static fallback list so the filter builder paints instantly
 * before the live fetch resolves. The live payload (Python source of truth) overrides
 * this; the fallback only needs to be shape-correct, not authoritative.
 */

export interface FilterFieldDef {
  field: string;
  label: string;
  type: "categorical" | "numeric" | "text";
  level: string;
  operators: string[];
  value_source: "static_enum" | "distinct_query" | "range" | "free_text";
  enum_values: string[];
  /** Integer-typed numeric field (tokens/latency/errors) — restrict input to whole numbers. */
  integer?: boolean;
  /**
   * The field is parameterized by a key, so its predicate carries a `key` slot and the
   * builder renders a key control before the operator. `metadata` is the only such field:
   * its keys are user data, so they are discovered per window rather than being registry
   * rows, and the registry stays one entry per field.
   */
  requires_key?: boolean;
}

/** GET /traces/filter-fields response. */
export interface FilterFieldsResponse {
  fields: FilterFieldDef[];
}

/** One distinct categorical value with its frequency. */
export interface FilterValue {
  value: string;
  count: number;
}

/** GET /traces/filter-values/{field} response. */
export interface FilterValuesResponse {
  field: string;
  values: FilterValue[];
}

export const STATIC_FILTER_FIELDS: FilterFieldDef[] = [
  {
    field: "trace_id",
    label: "Trace ID",
    type: "text",
    level: "TRACE",
    operators: ["eq", "contains"],
    value_source: "free_text",
    enum_values: [],
  },
  {
    field: "model_name",
    label: "Model",
    type: "categorical",
    level: "SPAN_MEMBERSHIP",
    operators: ["in"],
    value_source: "distinct_query",
    enum_values: [],
  },
  {
    field: "environment",
    label: "Environment",
    type: "categorical",
    level: "SPAN_MEMBERSHIP",
    operators: ["in"],
    value_source: "distinct_query",
    enum_values: [],
  },
  {
    field: "cost",
    label: "Cost",
    type: "numeric",
    level: "SPAN_AGGREGATE",
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value_source: "range",
    enum_values: [],
  },
  {
    field: "total_tokens",
    label: "Tokens",
    type: "numeric",
    level: "SPAN_AGGREGATE",
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value_source: "range",
    enum_values: [],
    integer: true,
  },
  {
    field: "duration_ms",
    label: "Latency",
    type: "numeric",
    level: "SPAN_AGGREGATE",
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value_source: "range",
    enum_values: [],
    integer: true,
  },
  {
    field: "errors",
    label: "Errors",
    type: "numeric",
    level: "SPAN_AGGREGATE",
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value_source: "range",
    enum_values: [],
    integer: true,
  },
  {
    // Values are stored stringified, so string operators only — no per-key type inference.
    // `free_text` because the value is typed, not picked; the key is the discovered part.
    field: "metadata",
    label: "Metadata",
    type: "text",
    level: "KEYED_MAP",
    operators: ["eq", "contains"],
    value_source: "free_text",
    enum_values: [],
    requires_key: true,
  },
];
