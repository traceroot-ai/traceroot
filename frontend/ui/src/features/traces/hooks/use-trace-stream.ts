"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Span, TraceDetail } from "@/types/api";
import type { TraceSource } from "@/lib/api/traces";
import { enrichSpansWithPending } from "../utils";
import { traceQueryKey } from "./index";

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

interface UseTraceStreamResult {
  isStreaming: boolean;
}

/**
 * Hook that connects to the live trace SSE endpoint and merges incoming spans
 * into the React Query cache for the trace detail.
 *
 * When new spans arrive via SSE, the existing useQuery data is updated in-place,
 * causing SpanTreeView and SpanInfoPanel to re-render automatically.
 *
 * The key comes from traceQueryKey so it matches whatever the panel reads, source
 * included. setQueryData resolves by exact hash, so a key that differs by one
 * element merges into nothing and every span event is silently dropped — while
 * trace_complete still appears to work, because invalidateQueries matches by prefix.
 */
export function useTraceStream(
  projectId: string,
  traceId: string,
  enabled: boolean,
  source?: TraceSource,
): UseTraceStreamResult {
  const queryClient = useQueryClient();
  const [isStreaming, setIsStreaming] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || !projectId || !traceId) {
      return;
    }

    // The live endpoint reads by (project, trace id) alone — it does not scope
    // by source the way the trace-detail fetch does — so `source` goes into the
    // cache key below but not into this URL. If live.py ever scopes its reads,
    // forward `?source=` here too or internal traces will stop streaming.
    const url = `/api/projects/${projectId}/traces/${traceId}/live`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("spans", (event) => {
      try {
        const data = JSON.parse(event.data);
        const newSpans: Span[] = data.spans ?? [];

        if (newSpans.length === 0) return;

        setIsStreaming(true);

        queryClient.setQueryData<TraceDetail>(traceQueryKey(projectId, traceId, source), (prev) => {
          if (!prev) return prev;
          const merged = mergeSpans(prev.spans, newSpans);
          return {
            ...prev,
            spans: enrichSpansWithPending(merged),
          };
        });
      } catch {
        // Ignore malformed events
      }
    });

    es.addEventListener("trace_complete", () => {
      setIsStreaming(false);
      es.close();
      eventSourceRef.current = null;

      // Refetch to get the final consistent state from ClickHouse
      queryClient.invalidateQueries({ queryKey: traceQueryKey(projectId, traceId, source) });
    });

    es.onerror = () => {
      setIsStreaming(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsStreaming(false);
    };
    // `source` belongs here: it is part of the cache key this effect writes to. Omitting
    // it lets the panel re-key its useQuery while the stream keeps writing the old key —
    // the exact silent span-dropping this hook was fixed for.
  }, [projectId, traceId, enabled, source, queryClient]);

  return { isStreaming };
}
