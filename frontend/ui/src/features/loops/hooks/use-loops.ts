import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  CreateLoopInput,
  LoopSummaryDto,
  Paged,
  UpdateLoopInput,
} from "@traceroot/core/loops/pure";
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
