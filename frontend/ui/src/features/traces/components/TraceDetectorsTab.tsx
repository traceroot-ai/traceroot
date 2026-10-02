"use client";

import Link from "next/link";
import { signalDeepLinkPath } from "@traceroot/core/signals";
import { cn, formatDate, buildUrlWithFilters, parseAsUTC } from "@/lib/utils";
import {
  useTraceDetectorRuns,
  selfTraceId,
  type BackendRun,
} from "@/features/detectors/hooks/use-findings";
import { LoadingState } from "@/components/ui/loading-state";
import {
  DETECTOR_TH,
  DETECTOR_TD,
  IdentifiedBadge,
  SummaryText,
} from "@/features/detectors/components/detector-table-cells";
import {
  useTraceSignals,
  type DetectorSignalSetting,
  type TraceSignalHit,
} from "@/ee/features/signals/hooks";

/** A run is "identified" when it produced a finding. */
function isIdentified(run: BackendRun): boolean {
  return run.finding_id != null;
}

/** Display name for a run, falling back to its detector id. */
function runName(run: BackendRun): string {
  return run.name ?? run.detector_id;
}

/** What the Signal column shows for one run. */
export type RunSignal =
  | { kind: "signal"; hit: TraceSignalHit }
  /** Identified, and its detector groups hits detected since then: not assigned yet. */
  | { kind: "pending" }
  /** Identified, but its detector did not group hits when it ran. */
  | { kind: "disabled" }
  | { kind: "none" };

/**
 * Pure so it can be unit-tested without rendering. `grouping` is whether the
 * deployment groups hits at all; without it nothing is ever assigned.
 */
export function runSignal(
  run: BackendRun,
  hit: TraceSignalHit | undefined,
  setting: DetectorSignalSetting | undefined,
  grouping: boolean,
): RunSignal {
  if (hit) return { kind: "signal", hit };
  if (!isIdentified(run) || !setting) return { kind: "none" };
  const grouped =
    grouping &&
    setting.enableSignals &&
    parseAsUTC(run.timestamp).getTime() >= new Date(setting.signalsEnabledAt).getTime();
  return { kind: grouped ? "pending" : "disabled" };
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
 * noise in this context. A detector's name links to its Runs tab; a
 * self-traced run deep-links straight to the run's own trace there. The Signal
 * column links a hit to the signal it was grouped into, or says the hit is
 * waiting for assignment or that its detector did not group it. Fetches its own
 * data by traceId, independent of the trace fetch in the parent panel.
 */
export function TraceDetectorsTab({ projectId, traceId }: TraceDetectorsTabProps) {
  const { data, isLoading, error } = useTraceDetectorRuns(projectId, traceId);
  const {
    data: signalsData,
    isPending: signalsPending,
    error: signalsError,
  } = useTraceSignals(
    projectId,
    traceId,
    (data?.runs ?? []).map((r) => r.detector_id),
    // So the query can poll on its own while one of these is still Pending.
    (data?.runs ?? [])
      .filter(isIdentified)
      .map((r) => ({ runId: r.run_id, detectorId: r.detector_id, timestamp: r.timestamp })),
  );

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingState label="Loading detectors..." />
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
  const signalByRun = new Map((signalsData?.hits ?? []).map((h) => [h.runId, h]));
  const settingByDetector = new Map((signalsData?.detectors ?? []).map((d) => [d.id, d]));

  if (runs.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-[13px] text-muted-foreground">No detectors ran on this trace</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background">
      <table aria-label="Trace detectors" className="w-full min-w-[820px] table-fixed">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b border-border bg-muted/50">
            <th className={cn(DETECTOR_TH, "w-[150px]")}>Name</th>
            <th className={cn(DETECTOR_TH, "w-[150px]")}>Timestamp</th>
            <th className={cn(DETECTOR_TH, "w-[80px]")}>Identified</th>
            <th className={DETECTOR_TH}>Summary</th>
            <th className={cn(DETECTOR_TH, "w-[220px] border-r-0")}>Signal</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            // Deep-link to the detector's Runs tab; the Findings tab is just that
            // runs list filtered to identified runs, so Runs is canonical. A
            // self-traced run additionally carries its own trace id + source so
            // the page auto-opens the run's actual trace on arrival.
            const detectorHref = buildUrlWithFilters(
              `/projects/${projectId}/detectors/${r.detector_id}`,
              {
                extraParams: r.self_traced
                  ? { tab: "runs", traceId: selfTraceId(r), source: "detector" }
                  : { tab: "runs" },
              },
            );
            const signal = runSignal(
              r,
              signalByRun.get(r.run_id),
              settingByDetector.get(r.detector_id),
              signalsData?.grouping ?? true,
            );
            return (
              <tr
                key={r.run_id}
                className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
              >
                <td className={cn(DETECTOR_TD, "text-foreground")}>
                  <Link
                    href={detectorHref}
                    title={runName(r)}
                    className="block truncate hover:underline focus-visible:underline"
                  >
                    {runName(r)}
                  </Link>
                </td>
                <td className={cn(DETECTOR_TD, "whitespace-nowrap text-muted-foreground")}>
                  {formatDate(r.timestamp)}
                </td>
                <td className={DETECTOR_TD}>
                  <IdentifiedBadge identified={isIdentified(r)} />
                </td>
                <td className={cn(DETECTOR_TD, "text-foreground")}>
                  <SummaryText summary={r.summary} />
                </td>
                <td className={cn(DETECTOR_TD, "border-r-0 text-foreground")}>
                  {signal.kind === "signal" ? (
                    <Link
                      href={signalDeepLinkPath(projectId, signal.hit.signalId)}
                      className="block truncate hover:underline focus-visible:underline"
                      title={signal.hit.signalTitle}
                    >
                      {signal.hit.signalTitle}
                    </Link>
                  ) : signalsPending && isIdentified(r) ? null : signalsError && isIdentified(r) ? (
                    <span className="text-muted-foreground" title="Signals could not be loaded">
                      Unavailable
                    </span>
                  ) : signal.kind === "pending" ? (
                    <span className="text-muted-foreground" title="Not grouped into a signal yet">
                      Pending
                    </span>
                  ) : signal.kind === "disabled" ? (
                    <span
                      className="text-muted-foreground"
                      title="Signal generation was disabled for this evaluation"
                    >
                      Disabled
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
