"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTraceApiUser } from "@/lib/hooks/use-trace-api-user";
import { getTraces } from "@/lib/api/traces";
import type { TraceListItem } from "@/types/api";
import { formatDuration } from "@/lib/utils";
import type { TimeRange } from "../types";

interface TraceFeedWidgetProps {
  projectId: string;
  spec: { limit?: number };
  range: TimeRange;
}

function StatusChip({ errorCount }: { errorCount: number }) {
  if (errorCount > 0) {
    return (
      <span className="inline-flex rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
        ERROR
      </span>
    );
  }
  return (
    <span className="inline-flex rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
      OK
    </span>
  );
}

function fmtCost(cost: number | null | undefined): string {
  if (cost == null || cost === 0) return "—";
  return `$${cost.toFixed(4)}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function TraceFeedWidget({ projectId, spec, range }: TraceFeedWidgetProps) {
  const limit = spec.limit ?? 10;
  const { user, sessionReady } = useTraceApiUser();

  const { data, isPending, isError } = useQuery({
    queryKey: ["trace-feed", projectId, limit, range.start.getTime(), range.end.getTime()],
    queryFn: () =>
      getTraces(
        projectId,
        "",
        {
          page: 0,
          limit,
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
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="pb-1.5 pr-3 font-medium">Time</th>
            <th className="pb-1.5 pr-3 font-medium">Name</th>
            <th className="pb-1.5 pr-3 font-medium">Status</th>
            <th className="pb-1.5 pr-3 font-medium">Cost</th>
            <th className="pb-1.5 font-medium">Latency</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((trace: TraceListItem) => (
            <tr key={trace.trace_id} className="border-t border-border/60">
              <td className="whitespace-nowrap py-1 pr-3 text-muted-foreground">
                <Link
                  href={`/projects/${projectId}/traces?traceId=${trace.trace_id}`}
                  className="hover:underline"
                >
                  {fmtTime(trace.trace_start_time)}
                </Link>
              </td>
              <td className="max-w-[120px] truncate py-1 pr-3">
                <Link
                  href={`/projects/${projectId}/traces?traceId=${trace.trace_id}`}
                  className="hover:underline"
                  title={trace.name}
                >
                  {trace.name}
                </Link>
              </td>
              <td className="py-1 pr-3">
                <StatusChip errorCount={trace.error_count} />
              </td>
              <td className="py-1 pr-3 tabular-nums text-muted-foreground">
                {fmtCost(trace.total_cost)}
              </td>
              <td className="py-1 tabular-nums text-muted-foreground">
                {formatDuration(trace.duration_ms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
