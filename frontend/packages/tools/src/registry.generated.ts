// Generated from backend/rest/openapi/public.json — do not edit.
// Regenerate with: pnpm --filter @traceroot-ai/tools generate
import type { RegistryEntry } from "./types.js";

export const REGISTRY: readonly RegistryEntry[] = [
  {
    name: "export_trace",
    description: "Export the complete bundle (trace, spans, git context, manifest) for one trace.",
    method: "get",
    path: "/api/v1/public/traces/{trace_id}/export",
    inputSchema: {
      type: "object",
      properties: {
        trace_id: {
          type: "string",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated field groups to include: 'core' (tree/timing/status, always included), 'usage' (tokens/cost), 'io' (per-span input/output), 'metadata' (per-span metadata). Aliases: 'skeleton' (core,usage), 'full' (everything). Unknown groups return 400.",
        },
      },
      required: ["trace_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_finding",
    description: "Fetch one detector finding by id, with its full analysis detail.",
    method: "get",
    path: "/api/v1/public/detectors/findings/{finding_id}",
    inputSchema: {
      type: "object",
      properties: {
        finding_id: {
          type: "string",
        },
      },
      required: ["finding_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_finding_by_trace",
    description: "Fetch the detector finding attached to a specific trace, if any.",
    method: "get",
    path: "/api/v1/public/detectors/traces/{trace_id}/finding",
    inputSchema: {
      type: "object",
      properties: {
        trace_id: {
          type: "string",
        },
      },
      required: ["trace_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_session",
    description:
      "Fetch one session with all its traces (ids, names, status, I/O summaries). Use before deep-diving individual traces of a conversation.",
    method: "get",
    path: "/api/v1/public/sessions/{session_id}",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
        },
        start_after: {
          format: "date-time",
          type: "string",
          description: "Only traces at or after this time (inclusive, ISO 8601)",
        },
        end_before: {
          format: "date-time",
          type: "string",
          description: "Only traces before this time (exclusive, ISO 8601)",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_trace",
    description:
      "Fetch one trace with its span tree. Defaults to the lightweight skeleton projection; pass fields=full for per-span input/output/metadata.",
    method: "get",
    path: "/api/v1/public/traces/{trace_id}",
    inputSchema: {
      type: "object",
      properties: {
        trace_id: {
          type: "string",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated field groups to include: 'core' (tree/timing/status, always included), 'usage' (tokens/cost), 'io' (per-span input/output), 'metadata' (per-span metadata). Aliases: 'skeleton' (core,usage), 'full' (everything). Unknown groups return 400.",
        },
      },
      required: ["trace_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_detectors",
    description: "List the project's detectors (id, name, template, enabled flag, creation time).",
    method: "get",
    path: "/api/v1/public/detectors",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          default: 50,
          description: "Items per page",
          maximum: 200,
          minimum: 1,
          type: "integer",
        },
        start_after: {
          format: "date-time",
          type: "string",
          description: "Only detectors created at or after this time (inclusive, ISO 8601)",
        },
        end_before: {
          format: "date-time",
          type: "string",
          description: "Only detectors created before this time (exclusive, ISO 8601)",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "list_findings",
    description:
      "List detector findings for the project, optionally filtered by detector (id, name, or template), trace id, or time range.",
    method: "get",
    path: "/api/v1/public/detectors/findings",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          default: 50,
          description: "Items per page",
          maximum: 200,
          minimum: 1,
          type: "integer",
        },
        start_after: {
          format: "date-time",
          type: "string",
          description: "Only findings at or after this time (inclusive, ISO 8601)",
        },
        end_before: {
          format: "date-time",
          type: "string",
          description: "Only findings before this time (exclusive, ISO 8601)",
        },
        detector: {
          type: "string",
          description: "Filter by detector id, name, or template",
        },
        trace_id: {
          type: "string",
          description: "Filter to a single trace",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "list_sessions",
    description:
      "List recent sessions (groups of traces sharing a session id) for the project, with trace counts and durations. Search by session id substring.",
    method: "get",
    path: "/api/v1/public/sessions",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          default: 50,
          description: "Items per page",
          maximum: 200,
          minimum: 1,
          type: "integer",
        },
        search_query: {
          type: "string",
          description: "Search by session_id",
        },
        start_after: {
          format: "date-time",
          type: "string",
          description: "Only sessions with traces at or after this time (inclusive, ISO 8601)",
        },
        end_before: {
          format: "date-time",
          type: "string",
          description: "Only sessions with traces before this time (exclusive, ISO 8601)",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "list_trace_filter_values",
    description:
      "Discover the current values of a categorical trace filter field (e.g. model_name, environment) for the project — use before filtering the trace list by that field.",
    method: "get",
    path: "/api/v1/public/traces/filter-values/{field}",
    inputSchema: {
      type: "object",
      properties: {
        field: {
          type: "string",
        },
        start_after: {
          format: "date-time",
          type: "string",
          description: "Only consider spans starting at or after this timestamp",
        },
        end_before: {
          format: "date-time",
          type: "string",
          description: "Only consider spans starting before this timestamp",
        },
      },
      required: ["field"],
      additionalProperties: false,
    },
  },
  {
    name: "list_traces",
    description:
      "List recent traces for the project (newest first). Filter by time range, trace name, user id, or a free-text search across trace/session/user ids and names. Use this for discovery before fetching a specific trace. Structured filters (model, environment, cost, tokens, latency, error count, keyed metadata) are available via the typed filters parameter.",
    method: "get",
    path: "/api/v1/public/traces",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          default: 50,
          description: "Items per page",
          maximum: 200,
          minimum: 1,
          type: "integer",
        },
        start_after: {
          format: "date-time",
          type: "string",
          description: "Only traces that started at or after this time (inclusive, ISO 8601)",
        },
        end_before: {
          format: "date-time",
          type: "string",
          description: "Only traces that started before this time (exclusive, ISO 8601)",
        },
        name: {
          type: "string",
          description: "Filter by trace name (substring match)",
        },
        user_id: {
          type: "string",
          description: "Filter by the user id recorded on the trace",
        },
        search_query: {
          type: "string",
          description: "Search across trace_id, name, session_id, user_id",
        },
        filters: {
          items: {
            anyOf: [
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "trace_id",
                    title: "Trace ID",
                  },
                  op: {
                    enum: ["eq", "contains"],
                  },
                  value: {
                    maxLength: 1024,
                    minLength: 1,
                    type: "string",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "model_name",
                    title: "Model",
                  },
                  op: {
                    enum: ["in"],
                  },
                  value: {
                    items: {
                      maxLength: 1024,
                      type: "string",
                    },
                    minItems: 1,
                    type: "array",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "environment",
                    title: "Environment",
                  },
                  op: {
                    enum: ["in"],
                  },
                  value: {
                    items: {
                      maxLength: 1024,
                      type: "string",
                    },
                    minItems: 1,
                    type: "array",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "span_kind",
                    title: "Span kind",
                  },
                  op: {
                    enum: ["in"],
                  },
                  value: {
                    items: {
                      maxLength: 1024,
                      type: "string",
                    },
                    minItems: 1,
                    type: "array",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "status",
                    title: "Status",
                  },
                  op: {
                    enum: ["in"],
                  },
                  value: {
                    items: {
                      maxLength: 1024,
                      type: "string",
                    },
                    minItems: 1,
                    type: "array",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "name",
                    title: "Span name",
                  },
                  op: {
                    enum: ["in"],
                  },
                  value: {
                    items: {
                      maxLength: 1024,
                      type: "string",
                    },
                    minItems: 1,
                    type: "array",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "cost",
                    title: "Cost",
                  },
                  op: {
                    enum: ["eq", "gt", "gte", "lt", "lte"],
                  },
                  value: {
                    maximum: 999999999,
                    minimum: 0,
                    type: "number",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "total_tokens",
                    title: "Tokens",
                  },
                  op: {
                    enum: ["eq", "gt", "gte", "lt", "lte"],
                  },
                  value: {
                    maximum: 9223372036854776000,
                    minimum: 0,
                    type: "integer",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "duration_ms",
                    title: "Latency",
                  },
                  op: {
                    enum: ["eq", "gt", "gte", "lt", "lte"],
                  },
                  value: {
                    maximum: 9223372036854776000,
                    minimum: 0,
                    type: "integer",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "errors",
                    title: "Errors",
                  },
                  op: {
                    enum: ["eq", "gt", "gte", "lt", "lte"],
                  },
                  value: {
                    maximum: 18446744073709552000,
                    minimum: 0,
                    type: "integer",
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  field: {
                    const: "metadata",
                    title: "Metadata",
                  },
                  key: {
                    description: "Which metadata key the value is compared against",
                    maxLength: 256,
                    minLength: 1,
                    type: "string",
                  },
                  op: {
                    enum: ["eq", "contains"],
                  },
                  value: {
                    maxLength: 1024,
                    minLength: 1,
                    type: "string",
                  },
                },
                required: ["field", "key", "op", "value"],
                type: "object",
              },
            ],
          },
          maxItems: 20,
          type: "array",
          description:
            "JSON array of typed filter predicates ({field, op, value}); the field catalog and per-field operators are defined in the schema",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "whoami",
    description: "Identify the project and workspace the current credential belongs to.",
    method: "get",
    path: "/api/v1/public/whoami",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];
