/**
 * Internal project-scoped route templates, keyed by tool name, for surfaces
 * that call the internal API instead of the public one (via dispatch's
 * pathOverride). The extra `project_id` path param is supplied through
 * fixedArgs. Only the agent's current read set is bound; widening this map is
 * a deliberate per-tool decision.
 */
export const INTERNAL_BINDINGS: Readonly<Record<string, string>> = {
  list_traces: "/api/v1/projects/{project_id}/traces",
  list_sessions: "/api/v1/projects/{project_id}/sessions",
  get_session: "/api/v1/projects/{project_id}/sessions/{session_id}",
  list_detectors: "/api/v1/projects/{project_id}/detectors",
  get_detector: "/api/v1/projects/{project_id}/detectors/{detector_id}",
  list_findings: "/api/v1/projects/{project_id}/detectors/findings",
  get_finding: "/api/v1/projects/{project_id}/detectors/findings/{finding_id}",
  get_finding_by_trace: "/api/v1/projects/{project_id}/detectors/traces/{trace_id}/finding",
  // The dashboard mirror is served from the /internal prefix (dropped by the
  // ingress) with secret-only auth — it has no user-header surface at all.
  list_dashboards: "/api/v1/internal/projects/{project_id}/dashboards",
  get_dashboard: "/api/v1/internal/projects/{project_id}/dashboards/{dashboard_id}",
  get_dashboard_data: "/api/v1/internal/projects/{project_id}/dashboards/{dashboard_id}/data",
  run_widget_query: "/api/v1/projects/{project_id}/widgets/query",
  // The saved-widget reads live beside the dashboard mirror, on the same
  // secret-only /internal prefix.
  get_widget: "/api/v1/internal/projects/{project_id}/widgets/{widget_id}",
  get_widget_data: "/api/v1/internal/projects/{project_id}/widgets/{widget_id}/data",
  list_alerts: "/api/v1/internal/projects/{project_id}/alerts",
  get_alert: "/api/v1/internal/projects/{project_id}/alerts/{alert_id}",
  list_evaluations: "/api/v1/internal/projects/{project_id}/evaluations",
  list_evaluation_runs: "/api/v1/internal/projects/{project_id}/evaluation-runs",
  get_evaluation_run: "/api/v1/internal/projects/{project_id}/evaluation-runs/{run_id}",
  list_datasets: "/api/v1/internal/projects/{project_id}/datasets",
  get_dataset: "/api/v1/internal/projects/{project_id}/datasets/{dataset_id}",
  list_dataset_versions: "/api/v1/internal/projects/{project_id}/datasets/{dataset_id}/versions",
  get_dataset_version: "/api/v1/internal/projects/{project_id}/dataset-versions/{version_id}",
};

/**
 * Internal Next-app write route templates, keyed by tool name, for surfaces
 * that call the trusted-caller write routes directly. Tenancy and provenance
 * travel in the camelCase body, not the path: a create is a flat POST, and an
 * update (PATCH) or delete (DELETE) names the resource through the `{id}`
 * segment the caller fills from the tool's id argument. Only the agent's
 * current write set is bound — the project-tenancy tools; workspace and
 * project writes stay CLI/API surface — and widening this map is a
 * deliberate per-tool decision.
 */
export const INTERNAL_WRITE_BINDINGS: Readonly<Record<string, string>> = {
  create_detector: "/api/internal/write/detectors",
  create_dashboard: "/api/internal/write/dashboards",
  create_widget: "/api/internal/write/widgets",
  create_alert: "/api/internal/write/alerts",
  update_detector: "/api/internal/write/detectors/{id}",
  update_dashboard: "/api/internal/write/dashboards/{id}",
  update_widget: "/api/internal/write/widgets/{id}",
  update_alert: "/api/internal/write/alerts/{id}",
  set_alert_status: "/api/internal/write/alerts/{id}/status",
  delete_detector: "/api/internal/write/detectors/{id}",
  delete_dashboard: "/api/internal/write/dashboards/{id}",
  delete_widget: "/api/internal/write/widgets/{id}",
  delete_alert: "/api/internal/write/alerts/{id}",
};
