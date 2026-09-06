"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTraceApiUser } from "@/lib/hooks/use-trace-api-user";
import { getTraces } from "@/lib/api/traces";
import type { Predicate, TraceListItem } from "@/types/api";
import { canonicalizeFilters, isValidPredicate } from "@/features/filters/predicate";
import { formatCost, formatDuration } from "@/lib/utils";
import type { TimeRange } from "../types";

interface TraceFeedWidgetProps {
  projectId: string;
  // Filters use the trace-list predicate wire format; the spec is stored
  // JSON, so entries are validated before they reach the query.
  spec: { limit?: number; filters?: Predicate[] };
  range: TimeRange;
}

// Error count, styled to match the trace-list "Errors" column: a red count
// badge when a trace recorded errors, a muted zero otherwise.
function ErrorCount({ errorCount }: { errorCount: number }) {
  if (errorCount > 0) {
    return (
      <span className="inline-flex min-w-5 justify-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
        {errorCount}
      </span>
    );
  }
  return <span className="text-muted-foreground">0</span>;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function TraceFeedWidget({ projectId, spec, range }: TraceFeedWidgetProps) {
  const router = useRouter();
  const limit = spec.limit ?? 10;
  const filters = (spec.filters ?? []).filter(isValidPredicate);
  const { user, sessionReady } = useTraceApiUser();

  const { data, isPending, isError } = useQuery({
    queryKey: [
      "trace-feed",
      projectId,
      limit,
      canonicalizeFilters(filters),
      range.start.getTime(),
      range.end.getTime(),
    ],
    queryFn: () =>
      getTraces(
        projectId,
        "",
        {
          page: 0,
          limit,
          filters,
          start_after: range.start.toISOString(),
          end_before: range.end.toISOString(),
        },
        user,
      ),
    enabled: sessionReady && !!projectId,
  });

  // isPending (no data yet), not isLoading (pending AND fetching): while the
  // auth session is still resolving the query is disabled — not fetching — and
  // isLoading would fall through to the misleading "No traces" empty state.
  if (isPending) {
    return <p className="text-[11.5px] text-muted-foreground">Loading…</p>;
  }
  if (isError) {
    return <p className="text-[11.5px] text-red-500">Failed to load traces</p>;
  }

  const traces = data?.data ?? [];

  if (traces.length === 0) {
    return <p className="text-[11.5px] text-muted-foreground">No traces in this time range</p>;
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-left text-[11px] text-muted-foreground">
            <th className="pb-1.5 pr-3 font-medium">Timestamp</th>
            <th className="pb-1.5 pr-3 font-medium">Name</th>
            <th className="pb-1.5 pr-3 font-medium">Errors</th>
            <th className="pb-1.5 pr-3 font-medium">Cost</th>
            <th className="pb-1.5 font-medium">Latency</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((trace: TraceListItem) => {
            const href = `/projects/${projectId}/traces?traceId=${trace.trace_id}`;
            return (
              <tr
                key={trace.trace_id}
                // The whole row opens the trace, like the list pages' rows; the
                // hover prefetch stands in for the removed links' viewport prefetch.
                onClick={() => router.push(href)}
                onMouseEnter={() => router.prefetch(href)}
                className="cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/50"
              >
                <td className="whitespace-nowrap py-1 pr-3 text-muted-foreground">
                  {fmtTime(trace.trace_start_time)}
                </td>
                <td className="max-w-[120px] truncate py-1 pr-3" title={trace.name}>
                  {trace.name}
                </td>
                <td className="py-1 pr-3">
                  <ErrorCount errorCount={trace.error_count} />
                </td>
                <td className="py-1 pr-3 tabular-nums text-muted-foreground">
                  {formatCost(trace.total_cost)}
                </td>
                <td className="py-1 tabular-nums text-muted-foreground">
                  {formatDuration(trace.duration_ms)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
