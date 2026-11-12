import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  ACTIVE_RUN_STATUSES,
  type CreateLoopInput,
  type LoopFindingDto,
  type LoopMemoryDto,
  type LoopRunDto,
  type LoopSummaryDto,
  type Paged,
  type UpdateLoopInput,
} from "@traceroot/core/loops/pure";
import { LOOP_RUN_QUOTAS, PlanType } from "@traceroot/core";
import { getWorkspace } from "@/lib/api";
import { broadcastQueryInvalidation } from "@/lib/cross-tab-sync";
import { ApiError } from "@/lib/api/client";

export type Loop = LoopSummaryDto;

interface LoopListQuery {
  page?: number;
  limit?: number;
  search_query?: string;
}

/** The route's `{ error }` (or a fallback) as an ApiError a form can show. */
export async function failFromResponse(res: Response, fallback: string): Promise<never> {
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
  if (!res.ok) return failFromResponse(res, `Failed to fetch Loops: ${res.status}`);
  return res.json() as Promise<Paged<Loop>>;
}

async function fetchLoop(projectId: string, loopId: string): Promise<Loop> {
  const res = await fetch(`/api/projects/${projectId}/loops/${loopId}`);
  if (!res.ok) return failFromResponse(res, `Failed to fetch Loop: ${res.status}`);
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
export function invalidateLoopReads(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["loops"] });
  broadcastQueryInvalidation(["loops"]);
}

export function useLoopList(projectId: string, query: LoopListQuery = {}) {
  return useQuery({
    queryKey: [
      "loops",
      "list",
      projectId,
      query.page ?? 0,
      query.limit ?? 50,
      query.search_query ?? null,
    ],
    queryFn: () => fetchLoopList(projectId, query),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });
}

export function useLoop(projectId: string, loopId: string) {
  return useQuery({
    queryKey: ["loops", "byId", projectId, loopId],
    queryFn: () => fetchLoop(projectId, loopId),
    enabled: !!projectId && !!loopId,
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
        "Failed to create Loop",
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
        "Failed to update Loop",
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
        "Failed to delete Loop",
      ),
    onSuccess: () => invalidateLoopReads(queryClient),
  });
}

/** How often a page with a queued or running run looks again. */
export const ACTIVE_RUN_POLL_MS = 10_000;

const hasActiveRun = (runs: LoopRunDto[] | undefined) =>
  !!runs?.some((r) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status));

interface RunListQuery {
  page?: number;
  limit?: number;
}

/** A Loop's runs, newest first; looks again every 10 s while one is queued or running. */
export function useLoopRuns(projectId: string, loopId: string, query: RunListQuery = {}) {
  return useQuery({
    queryKey: ["loops", "runs", projectId, loopId, query.page ?? 0, query.limit ?? 50],
    queryFn: async (): Promise<Paged<LoopRunDto>> => {
      const params = new URLSearchParams({
        page: String(query.page ?? 0),
        limit: String(query.limit ?? 50),
      });
      const res = await fetch(`/api/projects/${projectId}/loops/${loopId}/runs?${params}`);
      if (!res.ok) return failFromResponse(res, `Failed to fetch runs: ${res.status}`);
      return res.json() as Promise<Paged<LoopRunDto>>;
    },
    enabled: !!projectId && !!loopId,
    placeholderData: (prev) => prev,
    refetchInterval: (q) => (hasActiveRun(q.state.data?.data) ? ACTIVE_RUN_POLL_MS : false),
  });
}

export function useLoopFindings(projectId: string, loopId: string, query: RunListQuery = {}) {
  return useQuery({
    queryKey: ["loops", "findings", projectId, loopId, query.page ?? 0, query.limit ?? 50],
    queryFn: async (): Promise<Paged<LoopFindingDto>> => {
      const params = new URLSearchParams({
        page: String(query.page ?? 0),
        limit: String(query.limit ?? 50),
      });
      const res = await fetch(`/api/projects/${projectId}/loops/${loopId}/findings?${params}`);
      if (!res.ok) return failFromResponse(res, `Failed to fetch findings: ${res.status}`);
      return res.json() as Promise<Paged<LoopFindingDto>>;
    },
    enabled: !!projectId && !!loopId,
    placeholderData: (prev) => prev,
  });
}

export function useLoopMemory(projectId: string, loopId: string) {
  return useQuery({
    queryKey: ["loops", "memory", projectId, loopId],
    queryFn: async (): Promise<LoopMemoryDto[]> => {
      const res = await fetch(`/api/projects/${projectId}/loops/${loopId}/memory`);
      if (!res.ok) return failFromResponse(res, `Failed to fetch memory: ${res.status}`);
      return ((await res.json()) as { data: LoopMemoryDto[] }).data;
    },
    enabled: !!projectId && !!loopId,
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

/** Which Loop (if any) owns each detector id; the Signals pages use it to say "Found by Loop ...". */
export function useLoopsByDetector(projectId: string) {
  return useQuery({
    queryKey: ["loops", "byDetector", projectId],
    queryFn: async () => {
      const { data } = await fetchLoopList(projectId, { page: 0, limit: 200 });
      return new Map(data.map((l) => [l.detectorId, { id: l.id, name: l.name }]));
    },
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

/** Whether the workspace has used up its Free Loop runs (runs are skipped as blocked until it upgrades). */
export function useLoopPlanLimit(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["workspace", workspaceId, "loopLimit"],
    queryFn: async () => {
      const ws = await getWorkspace(workspaceId!);
      const usage = ws.currentUsage?.loop;
      return {
        blocked: ws.loopBlocked === true,
        runsUsed: usage?.runsUsed ?? 0,
        included: LOOP_RUN_QUOTAS[PlanType.FREE].included,
        plan: ws.billingPlan ?? "free",
      };
    },
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}
