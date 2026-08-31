// Generated from backend/rest/openapi/public.json — do not edit.
// Regenerate with: pnpm --filter @traceroot-ai/tools generate
import type { RegistryEntry } from "./types.js";

export const REGISTRY: readonly RegistryEntry[] = [
  {
    name: "create_dashboard",
    description:
      "Create a dashboard in a project (idempotent on the dashboard name within the project); add charts to it with create_widget.",
    method: "post",
    path: "/api/v1/public/dashboards",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
        },
        name: {
          type: "string",
        },
        project_id: {
          type: "string",
        },
      },
      required: ["project_id", "name"],
      additionalProperties: false,
    },
    bodyParams: ["description", "name", "project_id"],
    policy: {
      approvalClass: "none",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "create_detector",
    description:
      "Create a detector (name, template, prompt, optional sampling/RCA settings) in a project — idempotent on the detector name within the project.",
    method: "post",
    path: "/api/v1/public/detectors",
    inputSchema: {
      type: "object",
      properties: {
        detection_model: {
          type: "string",
        },
        detection_provider: {
          type: "string",
        },
        detection_source: {
          type: "string",
        },
        enable_rca: {
          type: "boolean",
        },
        enabled: {
          type: "boolean",
        },
        name: {
          type: "string",
        },
        output_schema: {
          items: {},
          type: "array",
        },
        project_id: {
          type: "string",
        },
        prompt: {
          type: "string",
        },
        sample_rate: {
          type: "integer",
        },
        template: {
          type: "string",
        },
        trigger_conditions: {
          items: {},
          type: "array",
        },
      },
      required: ["project_id", "name", "template", "prompt"],
      additionalProperties: false,
    },
    bodyParams: [
      "detection_model",
      "detection_provider",
      "detection_source",
      "enable_rca",
      "enabled",
      "name",
      "output_schema",
      "project_id",
      "prompt",
      "sample_rate",
      "template",
      "trigger_conditions",
    ],
    policy: {
      approvalClass: "none",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "create_project",
    description:
      "Create a project in a workspace the logged-in user can write to (idempotent on the project name within the workspace).",
    method: "post",
    path: "/api/v1/public/projects",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        trace_ttl_days: {
          type: "integer",
        },
        workspace_id: {
          type: "string",
        },
      },
      required: ["workspace_id", "name"],
      additionalProperties: false,
    },
    bodyParams: ["name", "trace_ttl_days", "workspace_id"],
    agentHiddenParams: ["trace_ttl_days"],
    policy: {
      approvalClass: "none",
      minRole: "MEMBER",
      tenancy: "workspace",
    },
  },
  {
    name: "create_widget",
    description:
      'Add a widget (title, type, spec) to an existing dashboard. Type "query" charts a metric (spec: view/filters/metric/breakdown/display); type "trace_feed" lists recent traces (spec: predicate filters + limit). Strict create: every call adds a new widget. The spec schema enumerates the only available views, metrics, filter operators, and display types — nothing outside it exists. If the user asks for a visualization or option that is not in the schema (for example a display type the enum lacks), say so explicitly and propose the closest available match instead of silently substituting.',
    method: "post",
    path: "/api/v1/public/widgets",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
        },
        display_config: {
          additionalProperties: true,
          type: "object",
        },
        project_id: {
          type: "string",
        },
        spec: {
          description:
            'The widget\'s content. For type "query": a chart spec (view/filters/metric/breakdown/display). For type "trace_feed": a trace-list feed spec (predicate filters + row limit).',
          anyOf: [
            {
              additionalProperties: false,
              description:
                "Full declarative specification of a single dashboard widget.\n\nMirrors the canonical zod ``WidgetSpecSchema``\n(frontend/ui/src/features/dashboards/types.ts); the frontend\nwidget-spec-parity test guards the two against structural drift.",
              properties: {
                breakdown: {
                  type: "string",
                },
                display: {
                  additionalProperties: false,
                  description: "Controls how the query result is rendered on the dashboard.",
                  properties: {
                    type: {
                      enum: ["line", "area", "bar", "pie", "number", "table", "histogram"],
                      type: "string",
                    },
                  },
                  required: ["type"],
                  type: "object",
                },
                filters: {
                  items: {
                    additionalProperties: false,
                    description: "A single filter predicate applied to a widget query.",
                    properties: {
                      field: {
                        type: "string",
                      },
                      op: {
                        enum: ["=", "contains", ">", ">=", "<", "<="],
                        type: "string",
                      },
                      value: {
                        minLength: 1,
                        type: ["string", "number"],
                      },
                    },
                    required: ["field", "op", "value"],
                    type: "object",
                  },
                  type: "array",
                },
                metric: {
                  additionalProperties: false,
                  description:
                    "The measure and aggregation function that define the widget's y-axis.",
                  properties: {
                    agg: {
                      enum: ["count", "sum", "avg", "min", "max", "p50", "p95", "p99"],
                      type: "string",
                    },
                    measure: {
                      type: "string",
                    },
                  },
                  required: ["measure", "agg"],
                  type: "object",
                },
                view: {
                  enum: ["spans", "traces"],
                  type: "string",
                },
              },
              required: ["view", "metric", "display"],
              type: "object",
            },
            {
              additionalProperties: false,
              description:
                "Spec for a ``trace_feed`` widget: a filtered live list of recent traces.\n\nMirrors the trace-list predicate wire format (canonical shape: what\n``isValidPredicate`` in frontend/ui/src/features/filters/predicate.ts\naccepts and the dashboard seed produces). ``limit`` carries the trace-list\npage-size bound; it defaults to 10 rows in the renderer when omitted.",
              properties: {
                filters: {
                  items: {
                    anyOf: [
                      {
                        additionalProperties: false,
                        description:
                          "Membership predicate: the field's value is one of the listed strings.",
                        properties: {
                          field: {
                            type: "string",
                          },
                          key: {
                            maxLength: 256,
                            minLength: 1,
                            type: "string",
                          },
                          op: {
                            const: "in",
                            type: "string",
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
                        description:
                          "Numeric comparison predicate (equality or ordering) on a finite number.",
                        properties: {
                          field: {
                            type: "string",
                          },
                          key: {
                            maxLength: 256,
                            minLength: 1,
                            type: "string",
                          },
                          op: {
                            enum: ["eq", "gt", "gte", "lt", "lte"],
                            type: "string",
                          },
                          value: {
                            type: "number",
                          },
                        },
                        required: ["field", "op", "value"],
                        type: "object",
                      },
                      {
                        additionalProperties: false,
                        description: "Text predicate: exact match or substring containment.",
                        properties: {
                          field: {
                            type: "string",
                          },
                          key: {
                            maxLength: 256,
                            minLength: 1,
                            type: "string",
                          },
                          op: {
                            enum: ["eq", "contains"],
                            type: "string",
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
                    ],
                    type: "object",
                  },
                  maxItems: 20,
                  type: "array",
                },
                limit: {
                  maximum: 200,
                  minimum: 1,
                  type: "integer",
                },
              },
              type: "object",
            },
          ],
          type: "object",
        },
        title: {
          type: "string",
        },
        type: {
          type: "string",
        },
      },
      required: ["project_id", "dashboard_id", "title", "type", "spec"],
      additionalProperties: false,
    },
    bodyParams: ["dashboard_id", "display_config", "project_id", "spec", "title", "type"],
    policy: {
      approvalClass: "none",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "create_workspace",
    description:
      "Create a workspace administered by the logged-in user. Idempotent: re-creating a same-named workspace the caller already administers returns it instead of duplicating.",
    method: "post",
    path: "/api/v1/public/workspaces",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    bodyParams: ["name"],
    policy: {
      approvalClass: "none",
      minRole: "VIEWER",
      tenancy: "account",
    },
  },
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["trace_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_detector",
    description:
      "Fetch one detector's full configuration by id: prompt, output schema, sample rate, RCA and detection settings, and trigger conditions.",
    method: "get",
    path: "/api/v1/public/detectors/{detector_id}",
    inputSchema: {
      type: "object",
      properties: {
        detector_id: {
          type: "string",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["detector_id"],
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    description:
      "List the projects the logged-in user can access, across workspaces (id, name, workspace). User-credential-only account discovery: use it to resolve the project_id a project-scoped request needs. Optionally filter by workspace_id.",
    method: "get",
    path: "/api/v1/public/projects",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Restrict the result to projects in this workspace.",
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
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
        include_evaluations: {
          default: false,
          description:
            "Include traces produced by offline-evaluation runs. Excluded by default so evaluation runs do not appear in the production trace list.",
          type: "boolean",
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
                    type: "string",
                  },
                  op: {
                    enum: ["eq", "contains"],
                    type: "string",
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
                    type: "string",
                  },
                  op: {
                    enum: ["in"],
                    type: "string",
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
                    type: "string",
                  },
                  op: {
                    enum: ["in"],
                    type: "string",
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
                    type: "string",
                  },
                  op: {
                    enum: ["eq", "gt", "gte", "lt", "lte"],
                    type: "string",
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
                    type: "string",
                  },
                  op: {
                    enum: ["eq", "gt", "gte", "lt", "lte"],
                    type: "string",
                  },
                  value: {
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
                    type: "string",
                  },
                  op: {
                    enum: ["eq", "gt", "gte", "lt", "lte"],
                    type: "string",
                  },
                  value: {
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
                    type: "string",
                  },
                  op: {
                    enum: ["eq", "gt", "gte", "lt", "lte"],
                    type: "string",
                  },
                  value: {
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
                    type: "string",
                  },
                  key: {
                    description: "Which metadata key the value is compared against",
                    maxLength: 256,
                    minLength: 1,
                    type: "string",
                  },
                  op: {
                    enum: ["eq", "contains"],
                    type: "string",
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
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "list_workspaces",
    description:
      "List the workspaces the logged-in user belongs to (id, name, role). User-credential-only account discovery: it needs no project_id and is not available to project-scoped API keys.",
    method: "get",
    path: "/api/v1/public/workspaces",
    inputSchema: {
      type: "object",
      properties: {},
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
