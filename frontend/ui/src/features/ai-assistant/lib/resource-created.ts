/**
 * Structured `details` the agent's write tools attach to a successful tool
 * result (mirrors ResourceCreatedDetails in the agent service; the values
 * arrive as untyped JSON over the SSE stream, so everything is re-checked).
 */
export interface ResourceCreatedDetails {
  kind: "resource_created";
  resourceType: string;
  resourceId: string;
  /** The name the resource was actually created with, when the tool said. */
  name?: string;
  /** The name the call asked for, when the service created the resource
   *  under a different one because that name was already taken. */
  renamedFrom?: string;
  created: boolean;
  projectId?: string;
  workspaceId?: string;
  dashboardId?: string;
  /** A created alert's evaluation state, as the write route returned it. */
  alertState?: unknown;
}

/**
 * The receipt of an update (mirrors ResourceUpdatedDetails in the agent
 * service): which public fields actually changed — empty for a no-op edit —
 * and, for an alert, what the edit did to its evaluation state.
 */
export interface ResourceUpdatedDetails {
  kind: "resource_updated";
  resourceType: string;
  resourceId: string;
  /** The name the resource carries after the edit, when the tool said. */
  name?: string;
  changed: string[];
  stateReset?: boolean;
  pageCleared?: boolean;
  projectId?: string;
  dashboardId?: string;
  alertState?: unknown;
}

/**
 * The receipt of a delete (mirrors ResourceDeletedDetails in the agent
 * service): what is gone, the reason the model gave, what was removed with
 * it, and for an alert whether an open page went with it.
 */
export interface ResourceDeletedDetails {
  kind: "resource_deleted";
  resourceType: string;
  resourceId: string;
  name?: string;
  reason: string;
  cascaded?: Record<string, number>;
  pageCleared?: boolean;
  projectId?: string;
}

/**
 * The `details` of a tool result as a record, when it carries the given
 * kind with the two ids every receipt consumer reads — or null.
 */
function detailsOfKind(result: unknown, kind: string): Record<string, unknown> | null {
  if (typeof result !== "object" || result === null) return null;
  const details = (result as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (d.kind !== kind) return null;
  if (typeof d.resourceType !== "string" || typeof d.resourceId !== "string") return null;
  return d;
}

/**
 * The `resource_created` details of a write-tool result, or null when the
 * result is not one (or is malformed). The three fields every consumer reads
 * unconditionally — `resourceType`, `resourceId` and `created` — are
 * type-checked here; the scoping ids are optional in the payload, so
 * consumers that build on them re-check their types.
 */
export function resourceCreatedDetails(result: unknown): ResourceCreatedDetails | null {
  const d = detailsOfKind(result, "resource_created");
  if (d === null || typeof d.created !== "boolean") return null;
  return d as unknown as ResourceCreatedDetails;
}

/**
 * The `resource_updated` details of a write-tool result, or null. `changed`
 * is what the receipt lists, so it has to be a list of field names.
 */
export function resourceUpdatedDetails(result: unknown): ResourceUpdatedDetails | null {
  const d = detailsOfKind(result, "resource_updated");
  if (d === null) return null;
  if (!Array.isArray(d.changed) || !d.changed.every((field) => typeof field === "string")) {
    return null;
  }
  return d as unknown as ResourceUpdatedDetails;
}

/** Counts by name: a plain object whose every value is a finite number. */
function isCountMap(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((count) => typeof count === "number" && Number.isFinite(count));
}

/**
 * The `resource_deleted` details of a write-tool result, or null. The reason
 * is what the card quotes, so a receipt without one is not a delete receipt;
 * the cascade, when present, is read as counts by name, so anything else is
 * not one either.
 */
export function resourceDeletedDetails(result: unknown): ResourceDeletedDetails | null {
  const d = detailsOfKind(result, "resource_deleted");
  if (d === null || typeof d.reason !== "string") return null;
  if (d.cascaded !== undefined && !isCountMap(d.cascaded)) return null;
  return d as unknown as ResourceDeletedDetails;
}
