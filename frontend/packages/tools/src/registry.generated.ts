// Generated from backend/rest/openapi/public.json — do not edit.
// Regenerate with: pnpm --filter @traceroot-ai/tools generate
import type { RegistryEntry } from "./types.js";

export const REGISTRY: readonly RegistryEntry[] = [
  {
    name: "create_alert",
    description:
      "Create a threshold alert in a project: a measure of the spans view, aggregated over a window and compared to a threshold, with optional row filters and renotify/no-data settings. Strict create, never idempotent: alerts share names freely, so to avoid a duplicate list the project's alerts first and match the name.",
    method: "post",
    path: "/api/v1/public/alerts",
    inputSchema: {
      type: "object",
      properties: {
        aggregation: {
          enum: ["sum", "avg", "count", "max", "min", "p50", "p75", "p90", "p95", "p99", "uniq"],
          type: "string",
        },
        filters: {
          description: "Row predicates the measure is evaluated over",
          items: {
            additionalProperties: false,
            properties: {
              field: {
                description: "A span field, e.g. model_name or metadata",
                type: "string",
              },
              key: {
                description: "The map entry to compare; required for the metadata field",
                type: "string",
              },
              op: {
                enum: ["=", "contains"],
                type: "string",
              },
              value: {
                type: ["string", "number"],
              },
            },
            required: ["field", "op", "value"],
            type: "object",
          },
          type: "array",
        },
        measure: {
          description: "A measure of the view, e.g. latency, cost, count",
          type: "string",
        },
        name: {
          type: "string",
        },
        no_data_mode: {
          enum: ["HOLD", "ZERO", "NOTIFY"],
          type: "string",
          description: "What a window that measured nothing means; column default when omitted",
        },
        project_id: {
          type: "string",
        },
        renotify: {
          description: "How often an alert re-notifies while it stays in the alerting state.",
          properties: {
            interval_minutes: {
              description: "Minutes between repeat notifications; required when mode is EVERY",
              type: "integer",
            },
            mode: {
              enum: ["OFF", "EVERY"],
              type: "string",
            },
          },
          required: ["mode"],
          type: "object",
        },
        threshold: {
          type: "number",
        },
        threshold_operator: {
          enum: [">", ">=", "<", "<=", "=", "!="],
          type: "string",
        },
        view: {
          const: "SPANS",
          type: "string",
        },
        window: {
          enum: ["1m", "5m", "10m", "30m", "1h", "2h"],
          type: "string",
        },
      },
      required: [
        "project_id",
        "name",
        "view",
        "measure",
        "aggregation",
        "window",
        "threshold_operator",
        "threshold",
        "renotify",
      ],
      additionalProperties: false,
    },
    bodyParams: [
      "aggregation",
      "filters",
      "measure",
      "name",
      "no_data_mode",
      "project_id",
      "renotify",
      "threshold",
      "threshold_operator",
      "view",
      "window",
    ],
    policy: {
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
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
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "create_detector",
    description:
      "Create a detector (name, template, prompt, optional sampling/RCA settings) in a project — idempotent on the detector name within the project. The standard detector types (failure, hallucination, logic, task, safety) have canonical default instructions: pass the matching template id and OMIT prompt to use them. Only supply prompt when the user provides genuinely custom instructions — a supplied prompt is stored verbatim and overrides the template default.",
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
          description:
            "Detector instructions. Omit to adopt the canonical instructions of a standard template; required for any other template.",
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
          description:
            "Conditions gating WHICH completed traces the detector evaluates; omit or pass [] to evaluate every completed trace. Each condition is {field, op, value} (metadata also takes key): model_name/environment take =, !=; cost/total_tokens/duration_ms/errors take >, >=, <, <=, =; metadata takes =, contains. A condition is a deterministic pre-filter, not the flag decision - the prompt still judges every trace that passes.",
        },
      },
      required: ["project_id", "name", "template"],
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
      approvalClass: "confirm",
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
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "workspace",
    },
  },
  {
    name: "create_widget",
    description:
      'Add a widget (title, type, spec) to an existing dashboard. Type "query" charts a metric (spec: view/filters/metric/breakdown/display); type "trace_feed" lists recent traces (spec: predicate filters + limit). Strict create: every call adds a new widget. The spec schema enumerates the only available views, metrics, filter operators, and display types — nothing outside it exists. If the user asks for a visualization or option that is not in the schema (for example a display type the enum lacks), say so explicitly and propose the closest available match instead of silently substituting. Pick the view first — spans and traces expose different fields, and the enums in this schema are the complete field vocabulary for each view. If the user asks for a dimension or metric that exists on neither view, say so and propose the closest available one (for example "traces by model" is built on the spans view via model_name).',
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
                'Chart spec over the "spans" view; the enums below are the complete field vocabulary for this view.',
              properties: {
                breakdown: {
                  enum: ["name", "span_kind", "model_name", "environment", null],
                  type: ["string", "null"],
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
                        enum: [
                          "name",
                          "span_kind",
                          "status",
                          "model_name",
                          "environment",
                          "is_root",
                          "duration_ms",
                          "cost",
                          "input_tokens",
                          "output_tokens",
                          "cache_read_tokens",
                          "cache_write_tokens",
                          "total_tokens",
                          "metadata",
                        ],
                        type: "string",
                      },
                      key: {
                        type: "string",
                      },
                      op: {
                        enum: ["=", "contains", ">", ">=", "<", "<="],
                        type: "string",
                      },
                      value: {
                        type: ["string", "number"],
                        anyOf: [
                          {
                            minLength: 1,
                            type: "string",
                          },
                          {
                            type: "number",
                          },
                        ],
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
                      enum: [
                        "count",
                        "sum",
                        "avg",
                        "min",
                        "max",
                        "p50",
                        "p75",
                        "p90",
                        "p95",
                        "p99",
                        "uniq",
                      ],
                      type: "string",
                    },
                    measure: {
                      enum: [
                        "duration_ms",
                        "cost",
                        "input_tokens",
                        "output_tokens",
                        "cache_read_tokens",
                        "cache_write_tokens",
                        "total_tokens",
                        "tokens_per_second",
                        "trace_id",
                        "count",
                      ],
                      type: "string",
                    },
                  },
                  required: ["measure", "agg"],
                  type: "object",
                },
                view: {
                  const: "spans",
                  type: "string",
                },
              },
              required: ["view", "metric", "display"],
              type: "object",
            },
            {
              additionalProperties: false,
              description:
                'Chart spec over the "traces" view; the enums below are the complete field vocabulary for this view.',
              properties: {
                breakdown: {
                  enum: ["name", "user_id", "session_id", "environment", null],
                  type: ["string", "null"],
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
                        enum: [
                          "name",
                          "user_id",
                          "session_id",
                          "environment",
                          "duration_ms",
                          "cost",
                          "input_tokens",
                          "output_tokens",
                          "cache_read_tokens",
                          "cache_write_tokens",
                          "total_tokens",
                          "error_count",
                        ],
                        type: "string",
                      },
                      key: {
                        type: "string",
                      },
                      op: {
                        enum: ["=", "contains", ">", ">=", "<", "<="],
                        type: "string",
                      },
                      value: {
                        type: ["string", "number"],
                        anyOf: [
                          {
                            minLength: 1,
                            type: "string",
                          },
                          {
                            type: "number",
                          },
                        ],
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
                      enum: [
                        "count",
                        "sum",
                        "avg",
                        "min",
                        "max",
                        "p50",
                        "p75",
                        "p90",
                        "p95",
                        "p99",
                        "uniq",
                      ],
                      type: "string",
                    },
                    measure: {
                      enum: [
                        "duration_ms",
                        "cost",
                        "input_tokens",
                        "output_tokens",
                        "cache_read_tokens",
                        "cache_write_tokens",
                        "total_tokens",
                        "count",
                        "error_count",
                      ],
                      type: "string",
                    },
                  },
                  required: ["measure", "agg"],
                  type: "object",
                },
                view: {
                  const: "traces",
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
      approvalClass: "confirm",
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
      approvalClass: "confirm",
      minRole: "VIEWER",
      tenancy: "account",
    },
  },
  {
    name: "delete_alert",
    description:
      "Permanently delete an alert. An open page is discarded, not resolved (the response says when one was). Requires a reason (3-500 characters) stating why — the user's actual instruction, recorded on the audit row. Resolve the id by listing the project's alerts and matching the name; never delete more than the user named.",
    method: "delete",
    path: "/api/v1/public/alerts/{alert_id}",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: {
          type: "string",
        },
        project_id: {
          description: "The project the resource belongs to",
          type: "string",
        },
        reason: {
          description: "Why the resource is being deleted; recorded on the audit row",
          maxLength: 500,
          minLength: 3,
          type: "string",
        },
      },
      required: ["alert_id", "project_id", "reason"],
      additionalProperties: false,
    },
    policy: {
      approvalClass: "approval",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "delete_dashboard",
    description:
      "Permanently delete a dashboard together with its widgets. A project's last dashboard cannot be deleted. Requires a reason (3-500 characters) stating why — the user's actual instruction, recorded on the audit row. Resolve the id by listing the project's dashboards and matching the name; never delete more than the user named.",
    method: "delete",
    path: "/api/v1/public/dashboards/{dashboard_id}",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
        },
        project_id: {
          description: "The project the resource belongs to",
          type: "string",
        },
        reason: {
          description: "Why the resource is being deleted; recorded on the audit row",
          maxLength: 500,
          minLength: 3,
          type: "string",
        },
      },
      required: ["dashboard_id", "project_id", "reason"],
      additionalProperties: false,
    },
    policy: {
      approvalClass: "approval",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "delete_detector",
    description:
      "Permanently delete a detector; its existing findings stay readable. Requires a reason (3-500 characters) stating why — the user's actual instruction, recorded on the audit row. Resolve the id by listing the project's detectors and matching the name; never delete more than the user named.",
    method: "delete",
    path: "/api/v1/public/detectors/{detector_id}",
    inputSchema: {
      type: "object",
      properties: {
        detector_id: {
          type: "string",
        },
        project_id: {
          description: "The project the resource belongs to",
          type: "string",
        },
        reason: {
          description: "Why the resource is being deleted; recorded on the audit row",
          maxLength: 500,
          minLength: 3,
          type: "string",
        },
      },
      required: ["detector_id", "project_id", "reason"],
      additionalProperties: false,
    },
    policy: {
      approvalClass: "approval",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "delete_project",
    description:
      "Delete a project: it drops out of every list and read and its API keys stop authenticating (its data stays for the retention window). Requires ADMIN in the workspace and a reason (3-500 characters) that is recorded on the audit row.",
    method: "delete",
    path: "/api/v1/public/projects/{project_id}",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
        },
        reason: {
          description: "Why the resource is being deleted; recorded on the audit row",
          maxLength: 500,
          minLength: 3,
          type: "string",
        },
      },
      required: ["project_id", "reason"],
      additionalProperties: false,
    },
    policy: {
      approvalClass: "approval",
      minRole: "ADMIN",
      tenancy: "workspace",
    },
  },
  {
    name: "delete_widget",
    description:
      "Permanently delete one widget from its dashboard (its layout slot is removed with it). Requires a reason (3-500 characters) stating why — the user's actual instruction, recorded on the audit row. Resolve the id from the dashboard's detail; never delete more than the user named.",
    method: "delete",
    path: "/api/v1/public/widgets/{widget_id}",
    inputSchema: {
      type: "object",
      properties: {
        widget_id: {
          type: "string",
        },
        project_id: {
          description: "The project the resource belongs to",
          type: "string",
        },
        reason: {
          description: "Why the resource is being deleted; recorded on the audit row",
          maxLength: 500,
          minLength: 3,
          type: "string",
        },
      },
      required: ["widget_id", "project_id", "reason"],
      additionalProperties: false,
    },
    policy: {
      approvalClass: "approval",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "delete_workspace",
    description:
      "Permanently delete a workspace and everything in it: every project, its access keys, memberships and invites. Requires ADMIN, the workspace's current name typed as confirmation, and a reason (3-500 characters) that is recorded on the audit row. The caller's only workspace cannot be deleted. Not reversible.",
    method: "delete",
    path: "/api/v1/public/workspaces/{workspace_id}",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
        },
        name: {
          description: "The workspace's current name, typed as confirmation",
          type: "string",
        },
        reason: {
          description: "Why the resource is being deleted; recorded on the audit row",
          maxLength: 500,
          minLength: 3,
          type: "string",
        },
      },
      required: ["workspace_id", "name", "reason"],
      additionalProperties: false,
    },
    policy: {
      approvalClass: "approval",
      minRole: "ADMIN",
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
    name: "get_alert",
    description:
      "Fetch one alert's full rule by id: view, measure, aggregation, filters, window, threshold, renotify and no-data handling, plus its evaluation state. Resolve the alert id by listing the project's alerts and matching the name — never guess an id.",
    method: "get",
    path: "/api/v1/public/alerts/{alert_id}",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: {
          type: "string",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["alert_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_dashboard",
    description:
      "Fetch one dashboard with its widgets (id, title, type, query spec, creation time). Resolve the dashboard id by listing the project's dashboards and matching the name — never guess an id.",
    method: "get",
    path: "/api/v1/public/dashboards/{dashboard_id}",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["dashboard_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_dashboard_data",
    description:
      "Answer a dashboard's query widgets (up to 24) for one window — the way to say what a dashboard shows, not just what it contains. Resolve the dashboard id with list_dashboards and match its name; never guess an id. Takes a window like run_widget_query (range preset or explicit bounds; neither means the site's default). Widgets come back in the dashboard's order with a status each: ok with rows (a series carries every bucket; any other display is capped at 25 rows, with truncated set), skipped for a trace feed (read those with list_traces and the feed's filters), or error with a reason. Every figure you report must come from these rows, and name the window it was answered for.",
    method: "get",
    path: "/api/v1/public/dashboards/{dashboard_id}/data",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
        },
        range: {
          enum: ["30m", "1h", "3h", "6h", "1d", "7d", "14d", "30d", "60d", "90d"],
          type: "string",
          description:
            "A preset window ending now, by the site picker's id. Give this or explicit start_time/end_time; neither means the site's 24-hour default.",
        },
        start_time: {
          format: "date-time",
          type: "string",
        },
        end_time: {
          format: "date-time",
          type: "string",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["dashboard_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_dataset",
    description:
      "Read one evaluation dataset by id: its name, description, key, and current published version. A dataset with no published version has none, and its cases cannot be read until one exists.",
    method: "get",
    path: "/api/v1/public/datasets/{dataset_id}",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: {
          type: "string",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["dataset_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_dataset_version",
    description:
      "Read one immutable dataset version and its test cases (input, expected, metadata, and trace provenance where the case was captured from one). Always pass limit (for example 20) and follow next_cursor until it is null: without limit the whole version comes back in one response, which can be very large.",
    method: "get",
    path: "/api/v1/public/dataset-versions/{version_id}",
    inputSchema: {
      type: "object",
      properties: {
        version_id: {
          type: "string",
        },
        limit: {
          maximum: 1000,
          minimum: 1,
          type: "integer",
          description:
            "Test cases per page. Omit it, with no cursor, to receive the whole version in one response, as an SDK pulling the snapshot it will run does; pass it to page.",
        },
        cursor: {
          maxLength: 64,
          minLength: 1,
          type: "string",
          description: "Opaque cursor from a previous page",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["version_id"],
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
    name: "get_sql_schema",
    description:
      "List the tables and columns available to run_sql, with their types. Read this before writing a query: it is the whole surface a query may reference.",
    method: "get",
    path: "/api/v1/public/sql/schema",
    inputSchema: {
      type: "object",
      properties: {
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
    name: "get_widget",
    description:
      "Fetch one saved widget's definition by id: its title, type, the query spec exactly as stored (what get_widget_data runs), display config, timestamps, and the id and name of the dashboard it sits on. Resolve a widget id from get_dashboard (which lists a dashboard's widgets) — never guess an id. For what the widget shows, use get_widget_data.",
    method: "get",
    path: "/api/v1/public/widgets/{widget_id}",
    inputSchema: {
      type: "object",
      properties: {
        widget_id: {
          type: "string",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["widget_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_widget_data",
    description:
      "Answer one saved widget for a window — the way to say what a widget shows without re-sending its spec. Prefer this over run_widget_query whenever the widget already exists on a dashboard; run_widget_query is for a spec that is saved nowhere. Takes a widget id plus a window like run_widget_query (range preset or explicit start_time/end_time; neither means the site's default). The answer carries a status: ok with every row the engine returns (a series comes back whole; no row cap), skipped for a trace feed or legacy detector widget (read those with list_traces and the feed's filters), or error with a reason when the stored spec no longer runs. Every figure you report must come from these rows, and name the window it was answered for — the response echoes it and says when retention clamped it.",
    method: "get",
    path: "/api/v1/public/widgets/{widget_id}/data",
    inputSchema: {
      type: "object",
      properties: {
        widget_id: {
          type: "string",
        },
        range: {
          enum: ["30m", "1h", "3h", "6h", "1d", "7d", "14d", "30d", "60d", "90d"],
          type: "string",
          description:
            "A preset window ending now, by the site picker's id. Give this or explicit start_time/end_time; neither means the site's 24-hour default.",
        },
        start_time: {
          format: "date-time",
          type: "string",
        },
        end_time: {
          format: "date-time",
          type: "string",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["widget_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_alerts",
    description:
      "List the project's threshold alerts (id, name, rule summary, status, current severity, last evaluation and notification state, creator) with the project's alert capacity. Paginated; search_query matches the alert name. To resolve an alert by name, list here and match its name — never guess an alert id.",
    method: "get",
    path: "/api/v1/public/alerts",
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
        page: {
          default: 0,
          description: "0-based page index",
          maximum: 10000,
          minimum: 0,
          type: "integer",
        },
        search_query: {
          maxLength: 200,
          type: "string",
          description: "Case-insensitive substring match on the alert name",
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
    name: "list_dashboards",
    description:
      "List the project's dashboards (id, name, description, default flag, creator, widget count, timestamps). To resolve a dashboard by name, list here and match its name — never guess a dashboard id.",
    method: "get",
    path: "/api/v1/public/dashboards",
    inputSchema: {
      type: "object",
      properties: {
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
    name: "list_dataset_versions",
    description:
      "List a dataset's published versions, newest first, each with its case count and whether it is the current one. Versions are immutable snapshots; editing a dataset publishes a new one rather than changing an old one.",
    method: "get",
    path: "/api/v1/public/datasets/{dataset_id}/versions",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: {
          type: "string",
        },
        limit: {
          default: 50,
          description: "Versions per page",
          maximum: 200,
          minimum: 1,
          type: "integer",
        },
        cursor: {
          maxLength: 64,
          minLength: 1,
          type: "string",
          description: "Opaque cursor from a previous page",
        },
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
      },
      required: ["dataset_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_datasets",
    description:
      "List the project's evaluation datasets, newest first, with each dataset's current published version. Filter by a case-insensitive substring of the name. Use this for discovery before reading a specific dataset.",
    method: "get",
    path: "/api/v1/public/datasets",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          default: 50,
          description: "Datasets per page",
          maximum: 200,
          minimum: 1,
          type: "integer",
        },
        cursor: {
          maxLength: 64,
          minLength: 1,
          type: "string",
          description: "Opaque cursor from a previous page",
        },
        name: {
          maxLength: 200,
          minLength: 1,
          type: "string",
          description: "Case-insensitive substring of the name",
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
                    const: "span_kind",
                    title: "Span kind",
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
                    const: "status",
                    title: "Status",
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
                    const: "name",
                    title: "Span name",
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
    name: "run_sql",
    description:
      "Run one read-only SQL query over the project's own spans and traces and return the rows. Use get_sql_schema first to see the columns available; the query may only read the curated spans and traces tables, and results are capped and may be truncated.",
    method: "post",
    path: "/api/v1/public/sql",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
        max_rows: {
          maximum: 1000000,
          minimum: 1,
          type: "integer",
          description: "Rows to return, clamped down to the server ceiling",
        },
        parameters: {
          additionalProperties: true,
          maxProperties: 100,
          type: "object",
          description: "Values for {name:Type} placeholders in the query",
        },
        query: {
          description: "A single read-only SELECT over the public schema",
          maxLength: 65536,
          minLength: 1,
          type: "string",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    bodyParams: ["max_rows", "parameters", "query"],
    policy: {
      approvalClass: "none",
      minRole: "VIEWER",
      tenancy: "project",
    },
  },
  {
    name: "run_widget_query",
    description:
      "Run a widget query and return its rows — the way to answer a metric question (error counts, p95 latency, cost by model) without a dashboard existing. Takes the same spec shape as create_widget (view, metric, breakdown, display, filters) plus a window: a range preset by the site picker's id (1h, 1d, 7d, 30d, …) or explicit start_time/end_time; neither means the site's default 24-hour window. The response echoes the window it was answered for and says when retention clamped it. A read that happens to be a POST: nothing is written.",
    method: "post",
    path: "/api/v1/public/widgets/query",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description:
            "Target project for the request. Required when authenticating with a user session token (a user credential is only meaningful scoped to a project); for an API key it is optional and, if given, must match the key's project.",
        },
        bucket_seconds: {
          maximum: 86400,
          minimum: 1,
          type: "integer",
        },
        end_time: {
          format: "date-time",
          type: "string",
        },
        range: {
          enum: ["30m", "1h", "3h", "6h", "1d", "7d", "14d", "30d", "60d", "90d"],
          type: "string",
          description:
            "A preset window ending now, by the site picker's id. Give this or explicit start_time/end_time; neither means the site's 24-hour default.",
        },
        spec: {
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
                  key: {
                    type: "string",
                  },
                  op: {
                    enum: ["=", "contains", ">", ">=", "<", "<="],
                    type: "string",
                  },
                  value: {
                    type: ["string", "number"],
                    anyOf: [
                      {
                        minLength: 1,
                        type: "string",
                      },
                      {
                        type: "number",
                      },
                    ],
                  },
                },
                required: ["field", "op", "value"],
                type: "object",
              },
              type: "array",
            },
            metric: {
              additionalProperties: false,
              description: "The measure and aggregation function that define the widget's y-axis.",
              properties: {
                agg: {
                  enum: [
                    "count",
                    "sum",
                    "avg",
                    "min",
                    "max",
                    "p50",
                    "p75",
                    "p90",
                    "p95",
                    "p99",
                    "uniq",
                  ],
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
        start_time: {
          format: "date-time",
          type: "string",
        },
      },
      required: ["spec"],
      additionalProperties: false,
    },
    bodyParams: ["bucket_seconds", "end_time", "range", "spec", "start_time"],
    policy: {
      approvalClass: "none",
      minRole: "VIEWER",
      tenancy: "project",
    },
  },
  {
    name: "set_alert_status",
    description:
      "Pause (PAUSED) or resume (ACTIVE) an alert without touching its rule — prefer this over update_alert for pause and resume. Pausing keeps the severity the alert stopped at; resuming is a cold start (evaluation state reset, due now). PARKED is the evaluator's verdict and cannot be requested; pausing a parked alert is a conflict, resume it to run it again. Setting the status the alert already has changes nothing.",
    method: "patch",
    path: "/api/v1/public/alerts/{alert_id}/status",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: {
          type: "string",
        },
        project_id: {
          type: "string",
        },
        status: {
          enum: ["ACTIVE", "PAUSED"],
          type: "string",
        },
      },
      required: ["alert_id", "project_id", "status"],
      additionalProperties: false,
    },
    bodyParams: ["project_id", "status"],
    policy: {
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "update_alert",
    description:
      "Edit an alert's rule: name, view, measure, aggregation, filters, window, threshold_operator, threshold, renotify, no_data_mode. Fields left out are untouched; the patch is validated against the stored rule, so an aggregation edit must fit the stored measure. Any edit to an evaluated field (everything but name) resets the alert's evaluation state and clears any open page — the response reports state_reset and page_cleared, and lists the fields that actually changed. To pause or resume, use set_alert_status instead.",
    method: "patch",
    path: "/api/v1/public/alerts/{alert_id}",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: {
          type: "string",
        },
        aggregation: {
          enum: ["sum", "avg", "count", "max", "min", "p50", "p75", "p90", "p95", "p99", "uniq"],
          type: "string",
        },
        filters: {
          description: "Row predicates the measure is evaluated over",
          items: {
            additionalProperties: false,
            properties: {
              field: {
                description: "A span field, e.g. model_name or metadata",
                type: "string",
              },
              key: {
                description: "The map entry to compare; required for the metadata field",
                type: "string",
              },
              op: {
                enum: ["=", "contains"],
                type: "string",
              },
              value: {
                type: ["string", "number"],
              },
            },
            required: ["field", "op", "value"],
            type: "object",
          },
          type: "array",
        },
        measure: {
          description: "A measure of the view, e.g. latency, cost, count",
          type: "string",
        },
        name: {
          type: "string",
        },
        no_data_mode: {
          description: "What a window that measured nothing means",
          enum: ["HOLD", "ZERO", "NOTIFY"],
          type: "string",
        },
        project_id: {
          type: "string",
        },
        renotify: {
          description: "How often an alert re-notifies while it stays in the alerting state.",
          properties: {
            interval_minutes: {
              description: "Minutes between repeat notifications; required when mode is EVERY",
              type: "integer",
            },
            mode: {
              enum: ["OFF", "EVERY"],
              type: "string",
            },
          },
          required: ["mode"],
          type: "object",
        },
        threshold: {
          type: "number",
        },
        threshold_operator: {
          enum: [">", ">=", "<", "<=", "=", "!="],
          type: "string",
        },
        view: {
          const: "SPANS",
          type: "string",
        },
        window: {
          enum: ["1m", "5m", "10m", "30m", "1h", "2h"],
          type: "string",
        },
      },
      required: ["alert_id", "project_id"],
      additionalProperties: false,
    },
    bodyParams: [
      "aggregation",
      "filters",
      "measure",
      "name",
      "no_data_mode",
      "project_id",
      "renotify",
      "threshold",
      "threshold_operator",
      "view",
      "window",
    ],
    policy: {
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "update_dashboard",
    description:
      "Rename a dashboard or change its description. Fields left out are untouched; a null description clears it. Tile layout is not editable here. The response lists the fields that actually changed.",
    method: "patch",
    path: "/api/v1/public/dashboards/{dashboard_id}",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
        },
        description: {
          type: ["string", "null"],
          description: "null clears the description",
        },
        name: {
          type: "string",
        },
        project_id: {
          type: "string",
        },
      },
      required: ["dashboard_id", "project_id"],
      additionalProperties: false,
    },
    bodyParams: ["description", "name", "project_id"],
    policy: {
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "update_detector",
    description:
      "Edit a detector: name, prompt, enabled (the pause switch), sample_rate, enable_rca, output_schema, trigger_conditions, or the detection model settings. Send only the fields the user asked to change — fields left out are untouched, and a null detection_model/detection_provider/detection_source clears it. output_schema and trigger_conditions replace the whole array; [] removes the trigger. The template cannot change. Read the detector first so the proposal names its current values; the response lists the fields that actually changed.",
    method: "patch",
    path: "/api/v1/public/detectors/{detector_id}",
    inputSchema: {
      type: "object",
      properties: {
        detector_id: {
          type: "string",
        },
        detection_model: {
          type: ["string", "null"],
        },
        detection_provider: {
          type: ["string", "null"],
        },
        detection_source: {
          enum: ["system", "byok", null],
          type: ["string", "null"],
        },
        enable_rca: {
          type: "boolean",
        },
        enabled: {
          description:
            "The pause switch. Detection is ingestion-triggered, so enabling starts nothing retroactively.",
          type: "boolean",
        },
        name: {
          type: "string",
        },
        output_schema: {
          description: "Replaces the whole output schema array",
          items: {},
          type: "array",
        },
        project_id: {
          type: "string",
        },
        prompt: {
          description:
            "Detector instructions, stored verbatim. There is no reset to a template's default on update: send the canonical text to restore it.",
          type: "string",
        },
        sample_rate: {
          type: "integer",
        },
        trigger_conditions: {
          description:
            "Replaces the whole trigger array; [] removes the trigger so every completed trace is evaluated. Each condition is {field, op, value} (metadata also takes key): model_name/environment take =, !=; cost/total_tokens/duration_ms/errors take >, >=, <, <=, =; metadata takes =, contains.",
          items: {},
          type: "array",
        },
      },
      required: ["detector_id", "project_id"],
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
      "trigger_conditions",
    ],
    policy: {
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "update_project",
    description:
      "Edit a project's name (or, via the API, its trace retention). Fields left out are untouched; a null trace_ttl_days returns retention to the plan default. Requires ADMIN in the workspace. The response lists the fields that actually changed.",
    method: "patch",
    path: "/api/v1/public/projects/{project_id}",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
        },
        name: {
          type: "string",
        },
        trace_ttl_days: {
          type: ["integer", "null"],
          description: "Trace retention in days (1-365); null returns to the plan default",
        },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    bodyParams: ["name", "trace_ttl_days"],
    agentHiddenParams: ["trace_ttl_days"],
    policy: {
      approvalClass: "confirm",
      minRole: "ADMIN",
      tenancy: "workspace",
    },
  },
  {
    name: "update_widget",
    description:
      "Edit a widget's title, spec, or display_config. Fields left out are untouched; a sent spec replaces the whole spec and must be in the dialect of the widget's existing type (query: view/filters/metric/breakdown/display; trace_feed: predicate filters + limit) — the type itself cannot change. A null display_config resets it. Read the widget's dashboard first so the new spec starts from the current one; the spec schema enumerates the only available views, metrics, filter operators, and display types. The response lists the fields that actually changed.",
    method: "patch",
    path: "/api/v1/public/widgets/{widget_id}",
    inputSchema: {
      type: "object",
      properties: {
        widget_id: {
          type: "string",
        },
        display_config: {
          additionalProperties: true,
          type: ["object", "null"],
          description: "Replaces the whole display config; null resets it to {}",
        },
        project_id: {
          type: "string",
        },
        spec: {
          description:
            'Replaces the whole spec, in the dialect of the widget\'s stored type. For type "query": a chart spec (view/filters/metric/breakdown/display). For type "trace_feed": a trace-list feed spec (predicate filters + row limit).',
          anyOf: [
            {
              additionalProperties: false,
              description:
                'Chart spec over the "spans" view; the enums below are the complete field vocabulary for this view.',
              properties: {
                breakdown: {
                  enum: ["name", "span_kind", "model_name", "environment", null],
                  type: ["string", "null"],
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
                        enum: [
                          "name",
                          "span_kind",
                          "status",
                          "model_name",
                          "environment",
                          "is_root",
                          "duration_ms",
                          "cost",
                          "input_tokens",
                          "output_tokens",
                          "cache_read_tokens",
                          "cache_write_tokens",
                          "total_tokens",
                          "metadata",
                        ],
                        type: "string",
                      },
                      key: {
                        type: "string",
                      },
                      op: {
                        enum: ["=", "contains", ">", ">=", "<", "<="],
                        type: "string",
                      },
                      value: {
                        type: ["string", "number"],
                        anyOf: [
                          {
                            minLength: 1,
                            type: "string",
                          },
                          {
                            type: "number",
                          },
                        ],
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
                      enum: [
                        "count",
                        "sum",
                        "avg",
                        "min",
                        "max",
                        "p50",
                        "p75",
                        "p90",
                        "p95",
                        "p99",
                        "uniq",
                      ],
                      type: "string",
                    },
                    measure: {
                      enum: [
                        "duration_ms",
                        "cost",
                        "input_tokens",
                        "output_tokens",
                        "cache_read_tokens",
                        "cache_write_tokens",
                        "total_tokens",
                        "tokens_per_second",
                        "trace_id",
                        "count",
                      ],
                      type: "string",
                    },
                  },
                  required: ["measure", "agg"],
                  type: "object",
                },
                view: {
                  const: "spans",
                  type: "string",
                },
              },
              required: ["view", "metric", "display"],
              type: "object",
            },
            {
              additionalProperties: false,
              description:
                'Chart spec over the "traces" view; the enums below are the complete field vocabulary for this view.',
              properties: {
                breakdown: {
                  enum: ["name", "user_id", "session_id", "environment", null],
                  type: ["string", "null"],
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
                        enum: [
                          "name",
                          "user_id",
                          "session_id",
                          "environment",
                          "duration_ms",
                          "cost",
                          "input_tokens",
                          "output_tokens",
                          "cache_read_tokens",
                          "cache_write_tokens",
                          "total_tokens",
                          "error_count",
                        ],
                        type: "string",
                      },
                      key: {
                        type: "string",
                      },
                      op: {
                        enum: ["=", "contains", ">", ">=", "<", "<="],
                        type: "string",
                      },
                      value: {
                        type: ["string", "number"],
                        anyOf: [
                          {
                            minLength: 1,
                            type: "string",
                          },
                          {
                            type: "number",
                          },
                        ],
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
                      enum: [
                        "count",
                        "sum",
                        "avg",
                        "min",
                        "max",
                        "p50",
                        "p75",
                        "p90",
                        "p95",
                        "p99",
                        "uniq",
                      ],
                      type: "string",
                    },
                    measure: {
                      enum: [
                        "duration_ms",
                        "cost",
                        "input_tokens",
                        "output_tokens",
                        "cache_read_tokens",
                        "cache_write_tokens",
                        "total_tokens",
                        "count",
                        "error_count",
                      ],
                      type: "string",
                    },
                  },
                  required: ["measure", "agg"],
                  type: "object",
                },
                view: {
                  const: "traces",
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
      },
      required: ["widget_id", "project_id"],
      additionalProperties: false,
    },
    bodyParams: ["display_config", "project_id", "spec", "title"],
    policy: {
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "project",
    },
  },
  {
    name: "update_workspace",
    description:
      "Rename a workspace the logged-in user administers. Fields left out are untouched. The response lists the fields that actually changed; a name the caller already uses for another workspace is a conflict.",
    method: "patch",
    path: "/api/v1/public/workspaces/{workspace_id}",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
        },
        name: {
          type: "string",
        },
      },
      required: ["workspace_id"],
      additionalProperties: false,
    },
    bodyParams: ["name"],
    policy: {
      approvalClass: "confirm",
      minRole: "ADMIN",
      tenancy: "account",
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
