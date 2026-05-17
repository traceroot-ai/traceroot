import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface Detector {
  id: string;
  projectId: string;
  name: string;
  template: string;
  prompt: string;
  outputSchema: Array<{ name: string; type: string }>;
  sampleRate: number;
  detectionModel: string | null;
  detectionProvider: string | null;
  detectionSource: "system" | "byok" | null;
  createTime: string;
  updateTime: string;
  trigger?: { conditions: Array<{ field: string; op: string; value: unknown }> } | null;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
}

interface DetectorListQuery {
  page?: number;
  limit?: number;
  search_query?: string;
}

interface DetectorListResponse {
  data: Detector[];
  meta: PaginationMeta;
}

export interface CreateDetectorInput {
  name: string;
  template: string;
  prompt: string;
  outputSchema: Array<{ name: string; type: string }>;
  sampleRate?: number;
  triggerConditions?: Array<{ field: string; op: string; value: unknown }>;
  detectionModel?: string;
  detectionProvider?: string;
  detectionSource?: "system" | "byok";
}

async function fetchDetectorList(
  projectId: string,
  query: DetectorListQuery = {},
): Promise<DetectorListResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.search_query) params.set("search_query", query.search_query);

  const qs = params.toString();
  const url = `/api/projects/${projectId}/detectors${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch detectors: ${res.status}`);
  return res.json() as Promise<DetectorListResponse>;
}

async function fetchDetector(projectId: string, detectorId: string): Promise<Detector> {
  const res = await fetch(`/api/projects/${projectId}/detectors/${detectorId}`);
  if (!res.ok) throw new Error(`Failed to fetch detector: ${res.status}`);
  const data = (await res.json()) as { detector: Detector };
  return data.detector;
}

async function createDetector(projectId: string, input: CreateDetectorInput): Promise<Detector> {
  const res = await fetch(`/api/projects/${projectId}/detectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to create detector: ${res.status}`);
  const data = (await res.json()) as { detector: Detector };
  return data.detector;
}

export interface UpdateDetectorInput {
  name?: string;
  prompt?: string;
  sampleRate?: number;
  triggerConditions?: Array<{ field: string; op: string; value: unknown }>;
  detectionModel?: string;
  detectionProvider?: string;
  detectionSource?: "system" | "byok";
}

async function updateDetector(
  projectId: string,
  detectorId: string,
  input: UpdateDetectorInput,
): Promise<Detector> {
  const res = await fetch(`/api/projects/${projectId}/detectors/${detectorId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to update detector: ${res.status}`);
  const data = (await res.json()) as { detector: Detector };
  return data.detector;
}

async function deleteDetector(projectId: string, detectorId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/detectors/${detectorId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete detector: ${res.status}`);
}

/** List detectors for the list page (paginated, optional search). */
export function useDetectorList(projectId: string, query: DetectorListQuery = {}) {
  return useQuery({
    queryKey: [
      "detectors",
      "list",
      projectId,
      query.page ?? 0,
      query.limit ?? 50,
      query.search_query ?? null,
    ],
    queryFn: () => fetchDetectorList(projectId, query),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });
}

/** Look up a single detector by ID (used by detail page + edit panel). */
export function useDetector(projectId: string, detectorId: string) {
  return useQuery({
    queryKey: ["detectors", "byId", projectId, detectorId],
    queryFn: () => fetchDetector(projectId, detectorId),
    enabled: !!projectId && !!detectorId,
  });
}

interface DetectorCountsItem {
  finding_count: number;
  run_count: number;
}

async function fetchDetectorCounts(
  projectId: string,
  startAfter: string,
  endBefore?: string,
): Promise<Record<string, DetectorCountsItem>> {
  const params = new URLSearchParams({ start_after: startAfter });
  if (endBefore) params.set("end_before", endBefore);
  const res = await fetch(`/api/projects/${projectId}/detector-counts?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch detector counts: ${res.status}`);
  const body = (await res.json()) as { data: Record<string, DetectorCountsItem> };
  return body.data;
}

/** Aggregated finding/run counts per detector for a project + window. */
export function useDetectorCounts(
  projectId: string,
  opts: { start_after?: string; end_before?: string },
) {
  return useQuery({
    queryKey: ["detectors", "counts", projectId, opts.start_after ?? null, opts.end_before ?? null],
    queryFn: () => fetchDetectorCounts(projectId, opts.start_after!, opts.end_before),
    enabled: !!projectId && !!opts.start_after,
    staleTime: 30_000,
  });
}

export function useCreateDetector(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDetectorInput) => createDetector(projectId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["detectors"] });
    },
  });
}

export function useUpdateDetector(projectId: string, detectorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDetectorInput) => updateDetector(projectId, detectorId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["detectors"] });
    },
  });
}

export function useDeleteDetector(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (detectorId: string) => deleteDetector(projectId, detectorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["detectors"] });
    },
  });
}
