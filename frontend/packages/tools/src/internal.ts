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
};
