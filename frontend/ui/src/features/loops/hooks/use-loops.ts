import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  ACTIVE_RUN_STATUSES,
  type CreateLoopInput,
  type LoopMemoryDto,
  type LoopRunDto,
  type LoopSummaryDto,
  type Paged,
  type UpdateLoopInput,
} from "@traceroot/core/loops/pure";
import { DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core/llm-providers";
import type { LLMModelsResponse } from "@/lib/api";
import {
  useAvailableLLMModels,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import {
  flattenAvailableModels,
  pickDefaultModel,
  type ResolvedModel,
} from "@/features/ai-assistant/lib/resolve-model";
import { broadcastQueryInvalidation } from "@/lib/cross-tab-sync";
import { ApiError } from "@/lib/api/client";

export type Loop = LoopSummaryDto;

interface LoopListQuery {
  page?: number;
  limit?: number;
  search_query?: string;
}

interface RunListQuery {
  page?: number;
  limit?: number;
  /** Only the runs that recorded this signal. */
  signalId?: string;
  /** Look again every 10 s: the Loop has a queued or running run, maybe on another page. */
  poll?: boolean;
}

/** `enabled` is false where loops are switched off (LOOPS_ENABLED), so nothing asks the 404ing route. */
interface LoopQueryOptions {
  enabled?: boolean;
}

/** Every Loop read's query key. One Loop's own reads share the `loop` prefix. */
export const loopKeys = {
  all: ["loops"] as const,
  lists: ["loops", "list"] as const,
  list: (projectId: string, query: LoopListQuery) =>
    [
      ...loopKeys.lists,
      projectId,
      query.page ?? 0,
      query.limit ?? 50,
      query.search_query ?? null,
    ] as const,
  loop: (projectId: string, loopId: string) => ["loops", "loop", projectId, loopId] as const,
  detail: (projectId: string, loopId: string) =>
    [...loopKeys.loop(projectId, loopId), "detail"] as const,
  runs: (projectId: string, loopId: string, query: RunListQuery) =>
    [
      ...loopKeys.loop(projectId, loopId),
      "runs",
      query.page ?? 0,
      query.limit ?? 50,
      query.signalId ?? null,
    ] as const,
  run: (projectId: string, loopId: string, runId: string | null) =>
    [...loopKeys.loop(projectId, loopId), "run", runId] as const,
  memory: (projectId: string) => ["loops", "memory", projectId] as const,
};

/** The route's `{ error }` (or a fallback) as an ApiError a form can show. */
async function failFromResponse(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  throw new ApiError(res.status, typeof body.error === "string" ? body.error : fallback);
}

async function fetchLoopList(projectId: string, query: LoopListQuery): Promise<Paged<Loop>> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.search_query) params.set("search_query", query.search_query);
  const qs = params.toString();
  const res = await fetch(`/api/projects/${projectId}/loops${qs ? `?${qs}` : ""}`);
  if (!res.ok) return failFromResponse(res, `Failed to fetch loops: ${res.status}`);
  return res.json() as Promise<Paged<Loop>>;
}

async function fetchLoop(projectId: string, loopId: string): Promise<Loop> {
  const res = await fetch(`/api/projects/${projectId}/loops/${loopId}`);
  if (!res.ok) return failFromResponse(res, `Failed to fetch loop: ${res.status}`);
  return ((await res.json()) as { loop: Loop }).loop;
}

async function send<T>(url: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) return failFromResponse(res, `${fallback}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** After a Loop changes: every Loop read, in this tab and the others. */
function invalidateLoopReads(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: loopKeys.all });
  broadcastQueryInvalidation([...loopKeys.all]);
}

export function useLoopList(
  projectId: string,
  query: LoopListQuery = {},
  { enabled = true }: LoopQueryOptions = {},
) {
  return useQuery({
    queryKey: loopKeys.list(projectId, query),
    queryFn: () => fetchLoopList(projectId, query),
    enabled: enabled && !!projectId,
    placeholderData: (prev) => prev,
  });
}

/** How often a page with a queued or running run looks again. */
const ACTIVE_RUN_POLL_MS = 10_000;

/** Whether a run is queued or running. */
export function isActiveRun(run: LoopRunDto | null | undefined): boolean {
  return !!run && ACTIVE_RUN_STATUSES.includes(run.status);
}

/** One Loop; looks again every 10 s while its last run is queued or running. */
export function useLoop(projectId: string, loopId: string) {
  return useQuery({
    queryKey: loopKeys.detail(projectId, loopId),
    queryFn: () => fetchLoop(projectId, loopId),
    enabled: !!projectId && !!loopId,
    refetchInterval: (q) => (isActiveRun(q.state.data?.lastRun) ? ACTIVE_RUN_POLL_MS : false),
  });
}

export function useCreateLoop(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLoopInput) =>
      send<{ loop: Loop }>(
        `/api/projects/${projectId}/loops`,
        "POST",
        input,
        "Failed to create loop",
      ),
    onSuccess: () => invalidateLoopReads(queryClient),
  });
}

export function useUpdateLoop(projectId: string, loopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateLoopInput) =>
      send<{ loop: Loop }>(
        `/api/projects/${projectId}/loops/${loopId}`,
        "PATCH",
        input,
        "Failed to update loop",
      ),
    onSuccess: () => invalidateLoopReads(queryClient),
  });
}

/** Pause or resume; resuming clears a system pause too. */
export function useSetLoopStatus(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { loopId: string; action: "pause" | "resume" }) =>
      send<{ loop: Loop }>(
        `/api/projects/${projectId}/loops/${input.loopId}/status`,
        "POST",
        { action: input.action },
        "Failed to change status",
      ),
    onSuccess: () => invalidateLoopReads(queryClient),
  });
}

export function useDeleteLoop(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (loopId: string) =>
      send<{ deleted: true }>(
        `/api/projects/${projectId}/loops/${loopId}`,
        "DELETE",
        undefined,
        "Failed to delete loop",
      ),
    // The deleted loop's own reads (its detail, runs, memory) would only 404 if
    // refetched while its page navigates away: cancel them and mark them stale
    // without refetching, then refresh every other loop read.
    // Removing them instead would let the still-mounted page fetch them afresh.
    // Deleting a loop changes only the lists among the other loop reads (its
    // memory notes stay), here and in the other tabs.
    onSuccess: async (_data, loopId) => {
      const own = { queryKey: loopKeys.loop(projectId, loopId) };
      await queryClient.cancelQueries(own);
      void queryClient.invalidateQueries({ ...own, refetchType: "none" });
      void queryClient.invalidateQueries({ queryKey: loopKeys.lists });
      broadcastQueryInvalidation([...loopKeys.lists]);
    },
  });
}

/**
 * A Loop's runs, newest first; looks again every 10 s while `poll` is set or the page shows a
 * queued or running run.
 */
export function useLoopRuns(
  projectId: string,
  loopId: string,
  query: RunListQuery = {},
  { enabled = true }: LoopQueryOptions = {},
) {
  return useQuery({
    queryKey: loopKeys.runs(projectId, loopId, query),
    queryFn: async (): Promise<Paged<LoopRunDto>> => {
      const params = new URLSearchParams({
        page: String(query.page ?? 0),
        limit: String(query.limit ?? 50),
        ...(query.signalId ? { signal_id: query.signalId } : {}),
      });
      const res = await fetch(`/api/projects/${projectId}/loops/${loopId}/runs?${params}`);
      if (!res.ok) return failFromResponse(res, `Failed to fetch runs: ${res.status}`);
      return res.json() as Promise<Paged<LoopRunDto>>;
    },
    enabled: enabled && !!projectId && !!loopId,
    placeholderData: (prev) => prev,
    refetchInterval: (q) =>
      query.poll || q.state.data?.data.some(isActiveRun) ? ACTIVE_RUN_POLL_MS : false,
  });
}

/** One run by id (a `?run=` link names a run that may be on no loaded page); pass null to skip. */
export function useLoopRun(projectId: string, loopId: string, runId: string | null) {
  return useQuery({
    queryKey: loopKeys.run(projectId, loopId, runId),
    queryFn: async (): Promise<LoopRunDto> => {
      const res = await fetch(`/api/projects/${projectId}/loops/${loopId}/runs/${runId}`);
      if (!res.ok) return failFromResponse(res, `Failed to fetch run: ${res.status}`);
      return ((await res.json()) as { run: LoopRunDto }).run;
    },
    enabled: !!projectId && !!loopId && !!runId,
  });
}

/** The project's Loop memory, shared by all its Loops. */
export function useLoopMemory(projectId: string) {
  return useQuery({
    queryKey: loopKeys.memory(projectId),
    queryFn: async (): Promise<LoopMemoryDto[]> => {
      const res = await fetch(`/api/projects/${projectId}/loop-memory`);
      if (!res.ok) return failFromResponse(res, `Failed to fetch memory: ${res.status}`);
      return ((await res.json()) as { data: LoopMemoryDto[] }).data;
    },
    enabled: !!projectId,
  });
}

/** Run now: queues a manual run for the worker's next tick. */
export function useRunLoop(projectId: string, loopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      send<{ run: LoopRunDto }>(
        `/api/projects/${projectId}/loops/${loopId}/run`,
        "POST",
        undefined,
        "Failed to start a run",
      ),
    onSuccess: () => invalidateLoopReads(queryClient),
  });
}

export interface LoopModelDefaults {
  /** What a new Loop starts on: the detector default when this workspace offers it, else null (the project's Agent model). */
  loopDefault: ModelSelection | null;
  /** What the project's Agent model resolves to while the project has none set. */
  agentDefault: ModelSelection | null;
}

const toSelection = (m: ResolvedModel | undefined): ModelSelection | null =>
  m ? { model: m.id, provider: m.provider, source: m.source, adapter: m.adapter } : null;

export function loopModelDefaults(data: LLMModelsResponse | undefined): LoopModelDefaults {
  const models = flattenAvailableModels(data, false);
  return {
    loopDefault: toSelection(
      models.find((m) => m.source === "system" && m.id === DETECTOR_SYSTEM_DEFAULT_MODEL_ID),
    ),
    agentDefault: toSelection(pickDefaultModel(models)),
  };
}

/** The workspace's model defaults for a Loop; shares the model pickers' cached list. */
export function useLoopModelDefaults(workspaceId: string | undefined) {
  const { data, isPending } = useAvailableLLMModels(workspaceId);
  return { ...loopModelDefaults(data), isPending };
}

/** A selection as a create or update body carries it; null follows the project's Agent model. */
export function loopModelFields(selection: ModelSelection | null) {
  return {
    model: selection?.model || null,
    provider: selection?.provider || null,
    source: selection?.source ?? null,
  };
}
