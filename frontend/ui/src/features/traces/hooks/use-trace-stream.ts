"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Span, TraceDetail } from "@/types/api";
import { enrichSpansWithPending } from "../utils";

/**
 * Merge incoming spans into existing spans array.
 * Incoming spans replace existing ones with the same span_id — real spans replace placeholders.
 *
 * Exported for unit testing: with two-phase loading the `existing` array holds
 * skeleton spans (no I/O) while `incoming` live-SSE spans carry full I/O +
 * metadata; both must flow through here without type/shape errors.
 */
export function mergeSpans(existing: Span[], incoming: Span[]): Span[] {
  const incomingIds = new Set(incoming.map((s) => s.span_id));
  return [...existing.filter((s) => !incomingIds.has(s.span_id)), ...incoming];
}

/**
 * Lifecycle of the live SSE stream as seen by the viewer:
 * - "connecting": opening the first connection, or reconnecting after an
 *   error or a server-side connection timeout.
 * - "live": connection open — span updates stream in as they are ingested.
 * - "ended": the trace completed and the stream closed normally.
 * - "disconnected": reconnect attempts are exhausted; the view is no longer
 *   live and may be missing recent spans until a reload.
 */
export type TraceStreamStatus = "connecting" | "live" | "ended" | "disconnected";

interface UseTraceStreamResult {
  isStreaming: boolean;
  streamStatus: TraceStreamStatus;
}

// Bounded exponential backoff for fatal connection failures (non-200
// responses put EventSource in CLOSED and the browser will not retry):
// 1s, 2s, 4s, 8s, 16s, then give up and mark the stream disconnected.
const MAX_RECONNECT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Hook that connects to the live trace SSE endpoint and merges incoming spans
 * into the React Query cache for the trace detail. When new spans arrive via
 * SSE, the existing useQuery data for ["trace", projectId, traceId] is updated
 * in-place, causing SpanTreeView and SpanInfoPanel to re-render automatically.
 *
 * Resilience: the server closes every connection at a fixed ceiling and
 * keeps no backlog, so any gap (timeout, network blip, reconnect) can drop
 * spans permanently. Each recovery path therefore refetches the trace detail
 * once to cover the gap: on reopen after a transient error, and on
 * `stream_timeout` before resubscribing. The server re-checks completion on
 * every subscribe and emits `trace_complete` immediately for finished
 * traces, so resubscribing after a timeout self-resolves either way.
 */
export function useTraceStream(
  projectId: string,
  traceId: string,
  enabled: boolean,
): UseTraceStreamResult {
  const queryClient = useQueryClient();
  const [streamStatus, setStreamStatus] = useState<TraceStreamStatus>("connecting");

  useEffect(() => {
    if (!enabled || !projectId || !traceId) {
      // A disabled stream is non-live; without this a consumer that toggles
      // `enabled` off mid-stream would keep reporting the last live status.
      setStreamStatus("ended");
      return;
    }

    const url = `/api/projects/${projectId}/traces/${traceId}/live`;
    const queryKey = ["trace", projectId, traceId];

    let disposed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let refetchInFlight = false;

    setStreamStatus("connecting");

    // At most one gap-covering refetch in flight: a timeout and a reconnect
    // can land close together, and each would otherwise hit the
    // trace-detail endpoint.
    const refetchGap = () => {
      if (refetchInFlight) return;
      refetchInFlight = true;
      queryClient.invalidateQueries({ queryKey }).finally(() => {
        refetchInFlight = false;
      });
    };

    const closeStream = () => {
      es?.close();
      es = null;
    };

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleConnect = (delayMs: number) => {
      if (disposed) return;
      clearRetryTimer();
      retryTimer = setTimeout(connect, delayMs);
    };

    function connect() {
      if (disposed) return;
      const source = new EventSource(url);
      es = source;
      setStreamStatus("connecting");

      // Set on a transient error; the next open then does a single
      // gap-covering refetch (one per reopen, not one per error event).
      let sawTransientError = false;

      source.onopen = () => {
        attempts = 0; // a healthy connection restores the full retry budget
        setStreamStatus("live");
        if (sawTransientError) {
          sawTransientError = false;
          refetchGap();
        }
      };

      source.addEventListener("spans", (event) => {
        try {
          const data = JSON.parse(event.data);
          const newSpans: Span[] = data.spans ?? [];

          if (newSpans.length === 0) return;

          queryClient.setQueryData<TraceDetail>(queryKey, (prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              spans: enrichSpansWithPending(mergeSpans(prev.spans, newSpans)),
            };
          });
        } catch {
          // Ignore malformed events
        }
      });

      source.addEventListener("trace_complete", () => {
        setStreamStatus("ended");
        closeStream();
        clearRetryTimer();

        // Refetch to get the final consistent state from ClickHouse
        queryClient.invalidateQueries({ queryKey });
      });

      source.addEventListener("stream_timeout", () => {
        // The server closed this connection at its per-connection ceiling;
        // the trace may still be running. Cover the cutover gap and
        // resubscribe — a finished trace resolves via the immediate
        // trace_complete on the fresh connection.
        closeStream();
        setStreamStatus("connecting");
        refetchGap();
        scheduleConnect(0);
      });

      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) {
          // Fatal: the browser will not retry. Back off and resubscribe
          // ourselves, up to the bound.
          closeStream();
          if (attempts >= MAX_RECONNECT_ATTEMPTS) {
            setStreamStatus("disconnected");
            return;
          }
          const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
          attempts += 1;
          setStreamStatus("connecting");
          scheduleConnect(delay);
        } else {
          // Transient: the browser auto-reconnects on its own; remember to
          // cover the gap once the connection reopens.
          sawTransientError = true;
          setStreamStatus("connecting");
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      clearRetryTimer();
      closeStream();
    };
  }, [projectId, traceId, enabled, queryClient]);

  return { isStreaming: streamStatus === "live", streamStatus };
}
