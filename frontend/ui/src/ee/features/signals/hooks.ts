import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SignalStatus } from "@traceroot/core/signals";
import { ApiError } from "@/lib/api/client";
import { serializeFiltersParam } from "@/features/filters/predicate";
import type { Predicate, TraceListItem } from "@/types/api";
import { getTracesByIds } from "@/lib/api/traces";
import { useTraceApiUser } from "@/lib/hooks/use-trace-api-user";

/** One row of the Signals list (dates arrive as ISO strings). */
export interface SignalListItem {
  id: string;
  detectorId: string;
  detectorName: string | null;
  title: string;
  status: SignalStatus;
  hitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createTime: string;
  /** Affected traces starting in the list's time window; present when the list was read with one. */
  rangeHitCount?: number;
}

export interface SignalListResponse {
  data: SignalListItem[];
  meta: { page: number; limit: number; total: number };
}

/** A time window as the date filter gives it: ISO bounds, a missing end is now. */
export interface SignalTimeRange {
  startAfter?: string;
  endBefore?: string;
}

export interface SignalListQuery extends SignalTimeRange {
  page?: number;
  limit?: number;
  filters?: Predicate[];
}

/** Which traces the chart compares a signal's against: its detector's, or the project's. */
export type SignalPopulation = "similar" | "all";

/** A signal with what its panel shows. */
export interface SignalDetail {
  merged: false;
  signal: SignalListItem & {
    criteriaCovers: string;
    criteriaExcludes: string;
    rca: { currentState: string | null; canonicalFindingId: string | null };
    canonicalRca: {
      findingId: string;
      traceId: string | null;
      sessionId: string | null;
      result: string | null;
    } | null;
  };
  /** The latest affected traces starting in the window. */
  hits: {
    runId: string;
    traceId: string;
    findingId: string;
    seenAt: string;
    traceStartTime: string;
  }[];
  window: { from: string; to: string; granularity: "hour" | "day" };
  /**
   * Per local hour or day of the window: the signal's traces, and the other
   * traces of the population (null when that count could not be read).
   */
  hitSeries: { bucket: string; hits: number; unaffected: number | null }[];
  /** Newest first. */
  statusEvents: {
    actorUserId: string;
    fromStatus: string;
    toStatus: string;
    reason: string | null;
    note: string | null;
    createTime: string;
  }[];
}

/** A status change as the status route takes it. */
export type SignalStatusChangeInput =
  | { status: "open"; note?: string | null }
  | { status: "resolved" | "dismissed"; reason: string; note?: string | null };

/** A signal merged into another returns only where it went. */
export type SignalResponse = SignalDetail | { merged: true; mergedIntoId: string };

async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? body.detail ?? `Failed to fetch ${what}`);
  }
  return res.json() as Promise<T>;
}

export function useSignals(projectId: string, query: SignalListQuery) {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.startAfter) params.set("start_after", query.startAfter);
  if (query.endBefore) params.set("end_before", query.endBefore);
  const filters = serializeFiltersParam(query.filters);
  if (filters) params.set("filters", filters);
  const qs = params.toString();
  return useQuery({
    queryKey: ["signals", "list", projectId, qs],
    queryFn: () =>
      getJson<SignalListResponse>(`/api/projects/${projectId}/signals?${qs}`, "signals"),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });
}

/** The viewer's IANA time zone, so chart buckets are their local hours and days. */
const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function useSignal(
  projectId: string,
  signalId: string | null,
  range: SignalTimeRange,
  population: SignalPopulation,
) {
  const params = new URLSearchParams({ tz: viewerTimeZone(), population });
  if (range.startAfter) params.set("start_after", range.startAfter);
  if (range.endBefore) params.set("end_before", range.endBefore);
  const qs = params.toString();
  return useQuery({
    queryKey: ["signals", "byId", projectId, signalId, qs],
    queryFn: () =>
      getJson<SignalResponse>(`/api/projects/${projectId}/signals/${signalId}?${qs}`, "signal"),
    enabled: !!projectId && !!signalId,
  });
}

/**
 * Change a signal's status. `expectedStatus` is the status the user saw, so a
 * change someone else made meanwhile is refused instead of overwritten.
 */
export function useSetSignalStatus(projectId: string, signalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      change: SignalStatusChangeInput;
      expectedStatus: SignalStatus;
    }) => {
      const res = await fetch(`/api/projects/${projectId}/signals/${signalId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error ?? "Failed to change the status");
      }
      return res.json() as Promise<{ status: SignalStatus; changed: boolean }>;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["signals"] }),
  });
}

/** Name, errors, cost and latency of a signal's traces, read from the trace store. */
export function useSignalTraces(projectId: string, traceIds: string[]) {
  const { user, sessionReady } = useTraceApiUser();
  return useQuery({
    queryKey: ["signals", "traces", projectId, traceIds.join(",")],
    queryFn: async () => {
      const res = await getTracesByIds(projectId, traceIds, user);
      return new Map<string, TraceListItem>(res.data.map((t) => [t.trace_id, t]));
    },
    enabled: sessionReady && !!projectId && traceIds.length > 0,
    staleTime: 60_000,
  });
}
