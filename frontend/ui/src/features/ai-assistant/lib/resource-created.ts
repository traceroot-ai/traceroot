/**
 * Structured `details` the agent's write tools attach to a successful tool
 * result (mirrors ResourceCreatedDetails in the agent service; the values
 * arrive as untyped JSON over the SSE stream, so everything is re-checked).
 */
export interface ResourceCreatedDetails {
  kind: "resource_created";
  resourceType: string;
  resourceId: string;
  created: boolean;
  projectId?: string;
  workspaceId?: string;
  dashboardId?: string;
}

/**
 * The `resource_created` details of a write-tool result, or null when the
 * result is not one (or is malformed). Only `resourceType` and `resourceId`
 * are type-checked here; the scoping ids are optional in the payload, so
 * consumers that build on them re-check their types.
 */
export function resourceCreatedDetails(result: unknown): ResourceCreatedDetails | null {
  if (typeof result !== "object" || result === null) return null;
  const details = (result as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (d.kind !== "resource_created") return null;
  if (typeof d.resourceType !== "string" || typeof d.resourceId !== "string") return null;
  return d as unknown as ResourceCreatedDetails;
}
