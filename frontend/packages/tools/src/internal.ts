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
  list_dashboards: "/api/v1/projects/{project_id}/dashboards",
  get_dashboard: "/api/v1/projects/{project_id}/dashboards/{dashboard_id}",
};
