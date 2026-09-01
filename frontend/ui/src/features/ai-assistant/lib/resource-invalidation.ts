import type { QueryKey } from "@tanstack/react-query";
import { resourceCreatedDetails } from "./resource-navigation";

/** An optional scoping id from the payload, kept only when it is really a string. */
function stringId(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Query keys made stale by a write the agent just performed server-side.
 *
 * The agent writes outside react-query, so nothing in the cache knows the row
 * exists; without this the new resource stays invisible until a refetch
 * trigger the user may never produce (they watch the agent work in the same
 * tab, so no window-focus refetch fires).
 *
 * Scoping ids come from the result payload rather than the panel's current
 * project, so a background session's write stales the project it actually
 * wrote to. Unknown resource types and malformed details yield no keys.
 */
export function invalidationKeysForResult(result: unknown): QueryKey[] {
  const details = resourceCreatedDetails(result);
  if (details === null) return [];
  const projectId = stringId(details.projectId);
  const workspaceId = stringId(details.workspaceId);
  const dashboardId = stringId(details.dashboardId);

  switch (details.resourceType) {
    case "dashboard":
      if (projectId === undefined) return [];
      return [
        ["dashboards", projectId],
        ["dashboard", projectId, details.resourceId],
      ];
    case "widget":
      // The widget's placement is written into the dashboard's layout, which
      // bumps the update time the dashboards list displays — so the list is
      // stale too. Matches useDashboardMutations.createWidget, whose
      // invalidateDashboards stales both the list and the dashboard itself.
      if (projectId === undefined || dashboardId === undefined) return [];
      return [
        ["dashboards", projectId],
        ["dashboard", projectId, dashboardId],
      ];
    case "detector":
      // Coarse on purpose: the detector list, counts, and by-id queries all
      // hang off this prefix, matching what the feature's own mutations do.
      return [["detectors"]];
    case "project": {
      const keys: QueryKey[] = [["workspaces"]];
      if (workspaceId !== undefined) {
        keys.push(["projects", workspaceId], ["workspace", workspaceId]);
      }
      return keys;
    }
    case "workspace":
      return [["workspaces"]];
    default:
      return [];
  }
}
