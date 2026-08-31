/**
 * Structured `details` the agent's write tools attach to a successful tool
 * result (mirrors ResourceCreatedDetails in the agent service; the values
 * arrive as untyped JSON over the SSE stream, so everything is re-checked).
 */
interface ResourceCreatedDetails {
  kind: "resource_created";
  resourceType: string;
  resourceId: string;
  created: boolean;
  projectId?: string;
}

function resourceCreatedDetails(result: unknown): ResourceCreatedDetails | null {
  if (typeof result !== "object" || result === null) return null;
  const details = (result as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (d.kind !== "resource_created") return null;
  if (typeof d.resourceType !== "string" || typeof d.resourceId !== "string") return null;
  return d as unknown as ResourceCreatedDetails;
}

/**
 * Route to auto-open when a live write-tool result reports a dashboard, or
 * null when the event must not move the user:
 * - only dashboards navigate (other resource types render in place);
 * - only events from the panel's active session (a background session's
 *   stream must never yank the user elsewhere);
 * - only within the panel's current project (no cross-project jumps from
 *   stale sessions).
 * A reused (created:false) dashboard still routes — it is what the user
 * asked to see.
 */
export function createdDashboardRoute(params: {
  /** The tool_execution_end event's result payload. */
  result: unknown;
  /** Session the stream delivering the event belongs to. */
  eventSessionId: string;
  /** The panel's currently active session, if any. */
  activeSessionId: string | null;
  /** The project the panel is currently mounted in. */
  panelProjectId: string | undefined;
}): string | null {
  const { result, eventSessionId, activeSessionId, panelProjectId } = params;
  if (activeSessionId === null || eventSessionId !== activeSessionId) return null;
  const details = resourceCreatedDetails(result);
  if (details === null || details.resourceType !== "dashboard") return null;
  if (panelProjectId === undefined || details.projectId !== panelProjectId) return null;
  return `/projects/${details.projectId}/dashboard/${details.resourceId}`;
}
