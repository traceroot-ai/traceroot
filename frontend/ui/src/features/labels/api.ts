import { fetchNextApi } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";

export interface ProjectLabel {
  id: string;
  name: string;
  description: string | null;
}

export interface TraceLabels {
  values: string[];
  appliedByMe: string[];
}

const projectLabelsPath = (projectId: string) => `/projects/${projectId}/labels`;

function traceLabelsPath(projectId: string, traceId: string, spanId: string | null) {
  const path = `/projects/${projectId}/traces/${traceId}/labels`;
  return spanId ? `${path}?${new URLSearchParams({ spanId })}` : path;
}

export async function listProjectLabels(projectId: string, signal: AbortSignal) {
  const { labels } = await fetchNextApi<{ labels: ProjectLabel[] }>(projectLabelsPath(projectId), {
    signal,
  });
  return labels;
}

export function createProjectLabel(projectId: string, name: string, description: string) {
  return fetchNextApi<{ label: ProjectLabel }>(projectLabelsPath(projectId), {
    method: "POST",
    body: JSON.stringify({ name, description: description || undefined }),
  });
}

export function updateProjectLabel(projectId: string, labelId: string, description: string) {
  return fetchNextApi<{ label: ProjectLabel }>(`${projectLabelsPath(projectId)}/${labelId}`, {
    method: "PATCH",
    body: JSON.stringify({ description: description || null }),
  });
}

export function deleteProjectLabel(projectId: string, labelId: string) {
  return fetchNextApi<void>(`${projectLabelsPath(projectId)}/${labelId}`, {
    method: "DELETE",
  });
}

export async function getTraceLabels(
  projectId: string,
  traceId: string,
  spanId: string | null,
  signal: AbortSignal,
) {
  try {
    return await fetchNextApi<TraceLabels>(traceLabelsPath(projectId, traceId, spanId), { signal });
  } catch (error) {
    // A missing, ineligible, or inaccessible target has no label controls.
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

export function setTraceLabel(
  projectId: string,
  traceId: string,
  spanId: string | null,
  value: string,
  checked: boolean,
) {
  return fetchNextApi<TraceLabels>(traceLabelsPath(projectId, traceId, spanId), {
    method: checked ? "PUT" : "DELETE",
    body: JSON.stringify({ value }),
  });
}
