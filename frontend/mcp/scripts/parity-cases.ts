/**
 * The parity mapping: for each of the 24 exposed tools, the MCP arguments, and
 * the baseline it is compared with. 20 tools are compared with a `traceroot-cli`
 * command (`traceroot ... --json`); 4 have no CLI command and are compared with
 * a plain HTTP request to the public API, written here without `dispatch()` so
 * the registry engine is never compared with itself.
 *
 * Only the normalisations in NORMALISE may differ between the two sides; any
 * other difference is a FAIL.
 */

export interface Seeds {
  traceId?: string;
  sessionId?: string;
  findingId?: string;
  findingTraceId?: string;
  detectorId?: string;
  alertId?: string;
  dashboardId?: string;
  widgetId?: string;
  datasetId?: string;
  versionId?: string;
  runId?: string;
  /** Fixed window shared by every windowed call, so no response echoes a moving "now". */
  start: string;
  end: string;
}

export interface HttpBaseline {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface ParityCase {
  /** Row label; `get_trace` appears twice (default and fields=full). */
  label: string;
  tool: string;
  /** Null when the seed data this call needs does not exist (the case is SKIPPED, never passed). */
  args: (s: Seeds) => Record<string, unknown> | null;
  /** CLI argv after `traceroot`, or the HTTP request when the tool has no CLI command. */
  cli?: (s: Seeds) => string[];
  http?: (s: Seeds) => HttpBaseline;
  /** Names of NORMALISE entries applied to the CLI side. */
  normaliseCli?: (keyof typeof NORMALISE)[];
  /** Names of NORMALISE entries applied to both sides. */
  normaliseBoth?: (keyof typeof NORMALISE)[];
}

/**
 * The fixed allow-list. Each entry removes keys the two sides legitimately
 * disagree on, with the reason; there is no other tolerance.
 */
export const NORMALISE = {
  // The CLI's list output adds the page size it printed and the window it described.
  "cli-list-envelope": {
    reason: "traceroot adds count and range to list --json",
    drop: ["count", "range"],
  },
  "cli-count": { reason: "traceroot adds count to alerts list --json", drop: ["count"] },
  // `traces get` also looks the trace's finding up, best effort, and adds it.
  "cli-finding": { reason: "traces get --json adds the trace's finding", drop: ["finding"] },
  // MCP withholds these by default (the content-withholding decision); fields=full returns them.
  "mcp-withheld": {
    reason: "get_trace withholds trace-level content unless fields asks for it",
    drop: ["input", "output", "metadata"],
  },
  "elapsed-ms": { reason: "a query reports how long it took", drop: ["elapsed_ms"] },
} as const;

const window = (s: Seeds) => ({ start_time: s.start, end_time: s.end });
const cliWindow = (s: Seeds) => ["--start-time", s.start, "--end-time", s.end];

export const CASES: ParityCase[] = [
  {
    label: "list_traces",
    tool: "list_traces",
    args: () => ({ limit: 5 }),
    cli: () => ["traces", "list", "--limit", "5"],
    normaliseCli: ["cli-list-envelope"],
  },
  {
    label: "get_trace",
    tool: "get_trace",
    args: (s) => (s.traceId ? { trace_id: s.traceId } : null),
    cli: (s) => ["traces", "get", s.traceId!],
    normaliseCli: ["cli-finding", "mcp-withheld"],
  },
  {
    label: "get_trace (fields=full)",
    tool: "get_trace",
    args: (s) => (s.traceId ? { trace_id: s.traceId, fields: "full" } : null),
    cli: (s) => ["traces", "get", s.traceId!, "--fields", "full"],
    normaliseCli: ["cli-finding"],
  },
  {
    label: "list_sessions",
    tool: "list_sessions",
    args: () => ({ limit: 5 }),
    http: () => ({ method: "GET", path: "/sessions", query: { limit: "5" } }),
  },
  {
    label: "get_session",
    tool: "get_session",
    args: (s) => (s.sessionId ? { session_id: s.sessionId } : null),
    http: (s) => ({ method: "GET", path: `/sessions/${s.sessionId}` }),
  },
  {
    label: "list_findings",
    tool: "list_findings",
    args: () => ({ limit: 5 }),
    cli: () => ["findings", "list", "--limit", "5"],
    normaliseCli: ["cli-list-envelope"],
  },
  {
    label: "get_finding",
    tool: "get_finding",
    args: (s) => (s.findingId ? { finding_id: s.findingId } : null),
    cli: (s) => ["findings", "get", s.findingId!],
  },
  {
    label: "get_finding_by_trace",
    tool: "get_finding_by_trace",
    args: (s) => (s.findingTraceId ? { trace_id: s.findingTraceId } : null),
    cli: (s) => ["findings", "get", "--trace", s.findingTraceId!],
  },
  {
    label: "list_detectors",
    tool: "list_detectors",
    args: () => ({ limit: 5 }),
    cli: () => ["detectors", "list", "--limit", "5"],
    normaliseCli: ["cli-list-envelope"],
  },
  {
    label: "get_detector",
    tool: "get_detector",
    args: (s) => (s.detectorId ? { detector_id: s.detectorId } : null),
    cli: (s) => ["detectors", "get", s.detectorId!],
  },
  {
    label: "list_alerts",
    tool: "list_alerts",
    args: () => ({ limit: 5 }),
    cli: () => ["alerts", "list", "--limit", "5"],
    normaliseCli: ["cli-count"],
  },
  {
    label: "get_alert",
    tool: "get_alert",
    args: (s) => (s.alertId ? { alert_id: s.alertId } : null),
    cli: (s) => ["alerts", "get", s.alertId!],
  },
  {
    label: "list_dashboards",
    tool: "list_dashboards",
    args: () => ({}),
    cli: () => ["dashboards", "list"],
  },
  {
    label: "get_dashboard",
    tool: "get_dashboard",
    args: (s) => (s.dashboardId ? { dashboard_id: s.dashboardId } : null),
    cli: (s) => ["dashboards", "get", s.dashboardId!],
  },
  {
    label: "get_dashboard_data",
    tool: "get_dashboard_data",
    args: (s) => (s.dashboardId ? { dashboard_id: s.dashboardId, ...window(s) } : null),
    http: (s) => ({ method: "GET", path: `/dashboards/${s.dashboardId}/data`, query: window(s) }),
  },
  {
    label: "run_widget_query",
    tool: "run_widget_query",
    args: (s) => ({ spec: WIDGET_SPEC, ...window(s) }),
    http: (s) => ({
      method: "POST",
      path: "/widgets/query",
      body: { spec: WIDGET_SPEC, ...window(s) },
    }),
  },
  {
    label: "get_widget",
    tool: "get_widget",
    args: (s) => (s.widgetId ? { widget_id: s.widgetId } : null),
    cli: (s) => ["widgets", "get", s.widgetId!],
  },
  {
    label: "get_widget_data",
    tool: "get_widget_data",
    args: (s) => (s.widgetId ? { widget_id: s.widgetId, ...window(s) } : null),
    cli: (s) => ["widgets", "data", s.widgetId!, ...cliWindow(s)],
  },
  {
    label: "get_evaluation_run",
    tool: "get_evaluation_run",
    args: (s) => (s.runId ? { run_id: s.runId } : null),
    cli: (s) => ["evals", "runs", "get", s.runId!],
  },
  {
    label: "list_datasets",
    tool: "list_datasets",
    args: () => ({ limit: 5 }),
    cli: () => ["datasets", "list", "--limit", "5"],
  },
  {
    label: "get_dataset",
    tool: "get_dataset",
    args: (s) => (s.datasetId ? { dataset_id: s.datasetId } : null),
    cli: (s) => ["datasets", "get", s.datasetId!],
  },
  {
    label: "list_dataset_versions",
    tool: "list_dataset_versions",
    args: (s) => (s.datasetId ? { dataset_id: s.datasetId, limit: 5 } : null),
    cli: (s) => ["datasets", "versions", "list", s.datasetId!, "--limit", "5"],
  },
  {
    label: "get_dataset_version",
    tool: "get_dataset_version",
    args: (s) => (s.versionId ? { version_id: s.versionId, limit: 5 } : null),
    cli: (s) => ["datasets", "versions", "get", s.versionId!, "--limit", "5"],
  },
  {
    label: "run_sql",
    tool: "run_sql",
    args: () => ({ query: SQL }),
    cli: () => ["sql", SQL],
    normaliseBoth: ["elapsed-ms"],
  },
  {
    label: "get_sql_schema",
    tool: "get_sql_schema",
    args: () => ({}),
    cli: () => ["sql", "schema"],
  },
];

const SQL = "SELECT count() AS n FROM traces";

const WIDGET_SPEC = {
  view: "spans",
  filters: [],
  metric: { measure: "cost", agg: "sum" },
  breakdown: "model_name",
  display: { type: "bar" },
};
