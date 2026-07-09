"use client";

import { useRouter } from "next/navigation";
import { cn, formatDate, buildUrlWithFilters } from "@/lib/utils";
import { useTraceDetectorRuns, type BackendRun } from "@/features/detectors/hooks/use-findings";
import {
  DETECTOR_TH,
  DETECTOR_TD,
  IdentifiedBadge,
  SummaryText,
} from "@/features/detectors/components/detector-table-cells";

/** A run is "identified" when it produced a finding. */
function isIdentified(run: BackendRun): boolean {
  return run.finding_id != null;
}

/** Display name for a run, falling back to its detector id. */
function runName(run: BackendRun): string {
  return run.name ?? run.detector_id;
}

/**
 * Order detector runs identified-first, then alphabetically by name. Pure so it
 * can be unit-tested in the default node environment.
 */
export function sortDetectorRuns(runs: BackendRun[]): BackendRun[] {
  return [...runs].sort((a, b) => {
    const ia = isIdentified(a);
    const ib = isIdentified(b);
    if (ia !== ib) return ia ? -1 : 1;
    return runName(a).localeCompare(runName(b));
  });
}

interface TraceDetectorsTabProps {
  projectId: string;
  traceId: string;
}

/**
 * Lists every detector that ran on a trace as a table, reusing the detector
 * page's table primitives for a consistent look. The trace-id and run-id
 * columns are dropped here — every row is this same trace, and the run id is
 * noise in this context. Clicking a row opens that detector's Runs tab. Fetches
 * its own data by traceId, independent of the trace fetch in the parent panel.
 */
export function TraceDetectorsTab({ projectId, traceId }: TraceDetectorsTabProps) {
  const router = useRouter();
  const { data, isLoading, error } = useTraceDetectorRuns(projectId, traceId);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-[13px] text-muted-foreground">Loading detectors...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-[13px] text-destructive">Error loading detectors</p>
      </div>
    );
  }

  const runs = sortDetectorRuns(data?.runs ?? []);

  if (runs.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-[13px] text-muted-foreground">No detectors ran on this trace</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background">
      <table className="w-full">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b border-border bg-muted/50">
            <th className={cn(DETECTOR_TH, "w-[220px]")}>Name</th>
            <th className={cn(DETECTOR_TH, "w-[160px]")}>Timestamp</th>
            <th className={cn(DETECTOR_TH, "w-[90px]")}>Identified</th>
            <th className={cn(DETECTOR_TH, "border-r-0")}>Summary</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            // Deep-link to the detector's Runs tab; the Findings tab is just that
            // runs list filtered to identified runs, so Runs is canonical.
            const detectorHref = buildUrlWithFilters(
              `/projects/${projectId}/detectors/${r.detector_id}`,
              { extraParams: { tab: "runs" } },
            );
            return (
              <tr
                key={r.run_id}
                onClick={() => router.push(detectorHref)}
                onMouseEnter={() => router.prefetch(detectorHref)}
                className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
              >
                <td className={cn(DETECTOR_TD, "text-foreground")}>{runName(r)}</td>
                <td className={cn(DETECTOR_TD, "whitespace-nowrap text-muted-foreground")}>
                  {formatDate(r.timestamp)}
                </td>
                <td className={DETECTOR_TD}>
                  <IdentifiedBadge identified={isIdentified(r)} />
                </td>
                <td className={cn(DETECTOR_TD, "max-w-[400px] border-r-0 text-foreground")}>
                  <SummaryText summary={r.summary} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
