import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SignalStatus } from "@traceroot/core/signals";
import { ApiError } from "@/lib/api/client";
import { serializeFiltersParam } from "@/features/filters/predicate";
import type { Predicate, TraceListItem } from "@/types/api";
import { getTracesByIds } from "@/lib/api/traces";
import { useTraceApiUser } from "@/lib/hooks/use-trace-api-user";
import { parseAsUTC } from "@/lib/utils";

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
  /** Whether this deployment groups hits and runs their RCA (it has the key signals run on). */
  grouping: boolean;
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
    // Keep the previous page while refetching, but only within the same
    // project — otherwise switching projects would show the old project's
    // rows with isLoading false. Mirrors evaluations/hooks.ts.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === projectId ? prev : undefined),
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
    // Follow a running root cause analysis until it finishes.
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && !data.merged && rcaInProgress(data.signal.rca.currentState)
        ? RCA_POLL_MS
        : false;
    },
  });
}

/** How often an open signal's panel rereads it while its analysis runs. */
const RCA_POLL_MS = 10_000;

/** Whether the current opening's analysis is waiting or running. */
export const rcaInProgress = (state: string | null) => state === "pending" || state === "running";

/** Run a signal's root cause analysis by hand; the worker starts it within about two minutes. */
export function useRequestSignalRca(projectId: string, signalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/signals/${signalId}/rca`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error ?? "Failed to start the analysis");
      }
      return res.json() as Promise<{ status: "pending" }>;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["signals", "byId", projectId] }),
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

/** A detector hit on one trace and the signal it was grouped into. */
export interface TraceSignalHit {
  runId: string;
  detectorId: string;
  findingId: string;
  signalId: string;
  signalTitle: string;
  signalStatus: SignalStatus;
}

/** Whether a detector groups its hits, and since when (ISO). */
export interface DetectorSignalSetting {
  id: string;
  enableSignals: boolean;
  signalsEnabledAt: string;
}

/** Just enough about an identified run to tell whether it is still waiting to be grouped. */
export interface IdentifiedTraceRun {
  runId: string;
  detectorId: string;
  timestamp: string;
}

/** How often the trace-signals query rereads while a hit is still waiting to be grouped. */
const TRACE_SIGNALS_POLL_MS = 10_000;

/**
 * Stop polling after this long: a hit can stay ungrouped for good once the
 * worker has given up on it, so polling forever would never end for it.
 */
const TRACE_SIGNALS_POLL_LIMIT_MS = 10 * 60 * 1000;

/**
 * Whether an identified run is still waiting to be grouped into a signal —
 * the same condition the trace's Detectors tab renders as "Pending". Pure so
 * it (and the polling it drives) can be unit-tested without a real query.
 */
export function isStillPendingGrouping(
  run: IdentifiedTraceRun,
  hitRunIds: ReadonlySet<string>,
  setting: DetectorSignalSetting | undefined,
  grouping: boolean,
): boolean {
  if (hitRunIds.has(run.runId) || !setting) return false;
  return (
    grouping &&
    setting.enableSignals &&
    parseAsUTC(run.timestamp).getTime() >= new Date(setting.signalsEnabledAt).getTime()
  );
}

/**
 * The trace-signals query's next poll delay given when the current pending
 * window started (null when nothing is pending): keep polling at the normal
 * cadence until the ~10-minute bound passes, then stop. Pure so the bound can
 * be unit-tested without real timers.
 */
export function traceSignalsPollDelay(pendingSince: number | null, now: number): number | false {
  if (pendingSince == null) return false;
  return now - pendingSince < TRACE_SIGNALS_POLL_LIMIT_MS ? TRACE_SIGNALS_POLL_MS : false;
}

/**
 * The pending window to bound polling by: the same one while the query key is
 * the same, a fresh one from `now` for another trace (or detector set).
 */
export function pendingWindow(
  previous: { key: string; since: number } | null,
  key: string,
  now: number,
): { key: string; since: number } {
  return previous?.key === key ? previous : { key, since: now };
}

/**
 * The signals a trace's detector hits were grouped into, and the signals
 * settings of the detectors that ran on it. Nothing else refetches this query
 * once the worker groups a hit after the page loads, so it polls while
 * `identifiedRuns` has a run that is grouped-but-not-yet-assigned (its
 * detector groups hits and was already doing so when the run happened, but no
 * hit for it is in the response yet) — the same condition the trace's
 * Detectors tab renders as "Pending". A run whose detector doesn't group
 * hits ("Disabled") never matches, so it never polls.
 */
export function useTraceSignals(
  projectId: string,
  traceId: string,
  detectorIds: string[],
  identifiedRuns: IdentifiedTraceRun[] = [],
) {
  const ids = [...new Set(detectorIds)].sort().join(",");
  // When the pending window started, so polling can be bounded; cleared once
  // nothing is pending, so a later run that becomes pending gets a fresh one.
  // Kept per query key, so a trace opened after another one starts its own.
  const pendingSinceRef = useRef<{ key: string; since: number } | null>(null);
  return useQuery({
    queryKey: ["signals", "trace", projectId, traceId, ids],
    queryFn: () =>
      getJson<{ hits: TraceSignalHit[]; detectors: DetectorSignalSetting[]; grouping: boolean }>(
        `/api/projects/${projectId}/traces/${traceId}/signals?${new URLSearchParams({ detector_ids: ids })}`,
        "trace signals",
      ),
    enabled: !!projectId && !!traceId && ids.length > 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hitRunIds = new Set(data.hits.map((h) => h.runId));
      const settingByDetector = new Map(data.detectors.map((d) => [d.id, d]));
      const stillPending = identifiedRuns.some((run) =>
        isStillPendingGrouping(
          run,
          hitRunIds,
          settingByDetector.get(run.detectorId),
          data.grouping,
        ),
      );
      if (!stillPending) {
        pendingSinceRef.current = null;
        return false;
      }
      const now = Date.now();
      pendingSinceRef.current = pendingWindow(
        pendingSinceRef.current,
        JSON.stringify(query.queryKey),
        now,
      );
      return traceSignalsPollDelay(pendingSinceRef.current.since, now);
    },
  });
}

/** How far the project is set up to produce signals; read when the list is empty. */
export interface SignalSetup {
  signalCount: number;
  detectorCount: number;
  signalDetectorCount: number;
  sampledSignalDetectorCount: number;
  /** Whether this deployment groups hits at all (it has the key signals run on). */
  grouping: boolean;
}

export function useSignalSetup(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["signals", "setup", projectId],
    queryFn: () => getJson<SignalSetup>(`/api/projects/${projectId}/signals/setup`, "signal setup"),
    enabled: enabled && !!projectId,
  });
}
