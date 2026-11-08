import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import type { TaskGroupsOverview, TraceTaskGroup } from "./types";

/** A time range as the date filter gives it: ISO bounds, a missing end is now. */
export interface TaskGroupsRange {
  startAfter?: string;
  endBefore?: string;
}

async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Failed to fetch ${what}`);
  }
  return res.json() as Promise<T>;
}

/** The groups of a project with their counts in the range, and the pipeline's state. */
export function useTaskGroups(projectId: string, range: TaskGroupsRange, enabled = true) {
  const params = new URLSearchParams();
  if (range.startAfter) params.set("start_after", range.startAfter);
  if (range.endBefore) params.set("end_before", range.endBefore);
  return useQuery({
    queryKey: ["task-groups", "overview", projectId, range.startAfter ?? "", range.endBefore ?? ""],
    queryFn: () =>
      getJson<TaskGroupsOverview>(
        `/api/projects/${projectId}/task-groups?${params.toString()}`,
        "topics",
      ),
    enabled: enabled && !!projectId,
    // The pipeline works in the background: pick up new summaries and fits.
    refetchInterval: 30_000,
  });
}

/** Turn the feature on or off, or change the daily spend cap. */
export function useUpdateTaskGroupSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: { enabled?: boolean; dailyCostCapUsd?: number }) => {
      const res = await fetch(`/api/projects/${projectId}/task-groups/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error ?? "Failed to save the setting");
      }
      return res.json() as Promise<{ enabled: boolean; dailyCostCapUsd: number }>;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["task-groups"] }),
  });
}

/** Ask for a fresh fit now. Refused with 429 when asked for within the last hour. */
export function useRefreshTaskGroups(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/task-groups/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error ?? "Failed to ask for a refresh");
      }
      return res.json() as Promise<{ accepted: boolean }>;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["task-groups"] }),
  });
}

/** Each listed trace's group, for the trace list's Topic column; read only while it is shown. */
export function useTraceTaskGroups(
  projectId: string,
  traceIds: readonly string[],
  enabled: boolean,
) {
  const params = new URLSearchParams(traceIds.map((id) => ["trace_id", id]));
  return useQuery({
    queryKey: ["task-groups", "by-trace", projectId, traceIds],
    queryFn: () =>
      getJson<{ groups: Record<string, TraceTaskGroup> }>(
        `/api/projects/${projectId}/task-groups/by-trace?${params.toString()}`,
        "trace topics",
      ),
    enabled: enabled && !!projectId && traceIds.length > 0,
    staleTime: 30_000,
  });
}
