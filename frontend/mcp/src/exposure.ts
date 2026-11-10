import { REGISTRY, type RegistryEntry } from "@traceroot-ai/tools";

/**
 * The tools this surface exposes. The registry decides what a tool is; this
 * list decides which of them an MCP client sees, as the CLI's placement map
 * does for commands. Milestone 1 is read-only: `exposedEntries` admits only
 * tools whose registry annotations say they read.
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
 * Params hidden on every exposed tool. An API key already fixes the project,
 * and the backend rejects a project_id that disagrees with it.
 */
export const SURFACE_HIDDEN_PARAMS: readonly string[] = ["project_id"];

/**
 * Resolve the exposed names to registry entries, failing on any that is
 * unknown or not a read. "A read" is the entry's own annotation (a GET, or a
 * POST its curation marks readOnly), never a list kept here.
 */
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
    if (entry.annotations?.readOnlyHint !== true || entry.annotations.destructiveHint) {
      throw new Error(
        `Exposed tool "${name}" is not annotated read-only; milestone 1 exposes reads only`,
      );
    }
    return entry;
  });
}
