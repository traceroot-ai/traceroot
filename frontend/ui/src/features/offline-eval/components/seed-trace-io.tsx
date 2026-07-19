"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { spanIOQueryKey } from "@/features/traces";
import type { TraceDetail } from "../types";

/**
 * Seeds the span-IO react-query cache from hardcoded traces, so the real
 * `SpanInfoPanel` (which reads span input/output/metadata from that cache, not
 * from the span object) shows the fixture values. The reading hook is auth-gated
 * and disabled in the prototype, but a disabled query still returns seeded data.
 *
 * Call once with all traces the page might open.
 */
export function useSeedTraceIO(projectId: string, details: TraceDetail[]) {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    for (const trace of details) {
      for (const span of trace.spans) {
        queryClient.setQueryData(spanIOQueryKey(projectId, trace.trace_id, span.span_id), {
          span_id: span.span_id,
          trace_id: trace.trace_id,
          input: span.input ?? null,
          output: span.output ?? null,
          metadata: span.metadata ?? null,
        });
      }
    }
    // details is a stable module-level fixture; seed once per project.
  }, [queryClient, projectId, details]);
}
