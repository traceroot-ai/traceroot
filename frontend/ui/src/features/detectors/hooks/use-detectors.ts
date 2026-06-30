import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { broadcastQueryInvalidation } from "@/lib/cross-tab-sync";

export interface Detector {
  id: string;
  projectId: string;
  name: string;
  template: string;
  prompt: string;
  outputSchema: Array<{ name: string; type: string }>;
  sampleRate: number;
  enableRca: boolean;
  detectionModel: string | null;
  detectionProvider: string | null;
  detectionSource: "system" | "byok" | null;
  createTime: string;
  updateTime: string;
  trigger?: { conditions: unknown } | null;
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
  enableRca?: boolean;
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

async function detectorError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown; detail?: unknown };
    const detail = typeof body.error === "string" ? body.error : body.detail;
    if (typeof detail === "string" && isSafeDetectorErrorMessage(res.status, detail)) {
      return new Error(detail.trim());
    }
  } catch {
    // Fall back to the status-only message when the response body is absent or invalid.
  }
  return new Error(`${fallback}: ${res.status}`);
}

const SAFE_DETECTOR_ERROR_MESSAGES = new Set([
  "Unauthorized",
  "Not a member of this workspace",
  "Project not found",
  "Detector not found",
  "Invalid JSON",
  "Body must be a JSON object",
  "name must be a non-empty string",
  "template must be a non-empty string",
  "prompt must be a non-empty string",
  "sampleRate must be an integer between 0 and 100",
  "enabled must be a boolean",
  "enableRca must be a boolean",
  "outputSchema must be an array",
  'detectionSource must be "system" or "byok"',
  "name must be a string",
  "prompt must be a string",
  "detectionModel must be a string",
  "detectionProvider must be a string",
  "detectionSource must be a string",
  "Admin role required to delete detectors",
]);

const TRIGGER_CONDITION_USER_MESSAGES = new Set([
  "Filter conditions must be an array.",
  "Each filter condition must include a field, operator, and value.",
  "Each filter condition needs a field.",
  "Only Environment filters are supported right now.",
  "Environment filters only support = or !=.",
  "Environment filter values must be text or null.",
]);

function isSafeTriggerConditionError(message: string): boolean {
  return triggerConditionErrorMessage(message) !== null;
}

function triggerConditionErrorMessage(message: string): string | null {
  if (message === "triggerConditions must be an array") {
    return "Filter conditions must be an array.";
  }
  if (/^triggerConditions\[\d+\] must be an object$/.test(message)) {
    return "Each filter condition must include a field, operator, and value.";
  }
  if (/^triggerConditions\[\d+\]\.field must be a non-empty string$/.test(message)) {
    return "Each filter condition needs a field.";
  }
  if (/^triggerConditions\[\d+\]\.field must be one of environment$/.test(message)) {
    return "Only Environment filters are supported right now.";
  }
  if (/^triggerConditions\[\d+\]\.op must be one of =, != for environment$/.test(message)) {
    return "Environment filters only support = or !=.";
  }
  if (/^triggerConditions\[\d+\]\.value must be a string or null for environment$/.test(message)) {
    return "Environment filter values must be text or null.";
  }
  return null;
}

function isSafeDetectorErrorMessage(status: number, message: string): boolean {
  const trimmed = message.trim();
  if (status < 400 || status >= 500 || trimmed.length === 0 || trimmed.length > 240) {
    return false;
  }
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return false;
  }
  return (
    SAFE_DETECTOR_ERROR_MESSAGES.has(trimmed) ||
    isSafeTriggerConditionError(trimmed) ||
    /^Requires (MEMBER|ADMIN) role or higher$/.test(trimmed)
  );
}

export function detectorMutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return triggerConditionErrorMessage(error.message.trim()) ?? error.message;
  }
  return fallback;
}

export function isTriggerConditionMutationError(message: string): boolean {
  const trimmed = message.trim();
  return (
    TRIGGER_CONDITION_USER_MESSAGES.has(trimmed) || triggerConditionErrorMessage(trimmed) !== null
  );
}

async function createDetector(projectId: string, input: CreateDetectorInput): Promise<Detector> {
  const res = await fetch(`/api/projects/${projectId}/detectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await detectorError(res, "Failed to create detector");
  const data = (await res.json()) as { detector: Detector };
  return data.detector;
}

export interface UpdateDetectorInput {
  name?: string;
  prompt?: string;
  sampleRate?: number;
  enableRca?: boolean;
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
  if (!res.ok) throw await detectorError(res, "Failed to update detector");
  const data = (await res.json()) as { detector: Detector };
  return data.detector;
}

async function deleteDetector(projectId: string, detectorId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/detectors/${detectorId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await detectorError(res, "Failed to delete detector");
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
      broadcastQueryInvalidation(["detectors"]);
    },
  });
}

export function useUpdateDetector(projectId: string, detectorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDetectorInput) => updateDetector(projectId, detectorId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["detectors"] });
      broadcastQueryInvalidation(["detectors"]);
    },
  });
}

export function useDeleteDetector(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (detectorId: string) => deleteDetector(projectId, detectorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["detectors"] });
      broadcastQueryInvalidation(["detectors"]);
    },
  });
}
