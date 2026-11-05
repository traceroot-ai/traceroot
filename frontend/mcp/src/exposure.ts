import { REGISTRY, type RegistryEntry } from "@traceroot-ai/tools";

/**
 * The tools this surface exposes. The registry decides what a tool is; this
 * list decides which of them an MCP client sees, as the CLI's placement map
 * does for commands. Milestone 1 is read-only because an API key cannot reach
 * a write route.
 */
export const EXPOSED_TOOLS = [
  "get_dashboard",
  "get_dashboard_data",
  "get_dataset",
  "get_dataset_version",
  "get_detector",
  "get_evaluation_run",
  "get_finding",
  "get_finding_by_trace",
  "get_session",
  "get_sql_schema",
  "get_trace",
  "get_widget",
  "get_widget_data",
  "get_alert",
  "list_alerts",
  "list_dashboards",
  "list_dataset_versions",
  "list_datasets",
  "list_detectors",
  "list_findings",
  "list_sessions",
  "list_traces",
  "run_sql",
  "run_widget_query",
] as const;

/**
 * POST tools that run a query rather than change anything. The registry
 * cannot say so yet, so the exposure map does; every other exposed tool must
 * be a GET.
 */
export const QUERY_ONLY_POSTS: ReadonlySet<string> = new Set(["run_sql", "run_widget_query"]);

/**
 * Params hidden on every exposed tool. An API key already fixes the project,
 * and the backend rejects a project_id that disagrees with it.
 */
export const SURFACE_HIDDEN_PARAMS: readonly string[] = ["project_id"];

/** Resolve the exposed names to registry entries, failing on any that is unknown or not a read. */
export function exposedEntries(
  registry: readonly RegistryEntry[] = REGISTRY,
  names: readonly string[] = EXPOSED_TOOLS,
): RegistryEntry[] {
  const byName = new Map(registry.map((entry) => [entry.name, entry]));
  return names.map((name) => {
    const entry = byName.get(name);
    if (entry === undefined) {
      throw new Error(`Exposed tool "${name}" is not in the registry`);
    }
    if (entry.method !== "get" && !QUERY_ONLY_POSTS.has(name)) {
      throw new Error(
        `Exposed tool "${name}" is a ${entry.method}; milestone 1 exposes reads only`,
      );
    }
    return entry;
  });
}
