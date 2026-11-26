"use client";

import { cn, formatCost, formatDate, formatDuration } from "@/lib/utils";
import {
  DETECTOR_TD,
  DETECTOR_TH,
  EmptyIdCell,
  IdCell,
  SummaryText,
} from "@/features/detectors/components/detector-table-cells";
import type { LoopRunDto } from "@traceroot/core/loops/pure";
import { runOutcomeLabel, runStatusShort } from "../loop-display";

/** Outcomes a person has to act on: the only ones not in the muted colour. */
const FAILED = new Set(["failed", "timed_out"]);

const EMPTY = "—";

/**
 * How long the run worked, or null when it did none: never started or never
 * finished, skipped, failed before its agent started (no session), or ended
 * the instant it began.
 */
function durationMs(run: LoopRunDto): number | null {
  if (!run.startedAt || !run.finishedAt || run.status.startsWith("skipped")) return null;
  if (run.status === "failed" && !run.sessionId) return null;
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return ms >= 1 ? ms : null;
}

interface LoopRunsTableProps {
  runs: LoopRunDto[];
  /** Opens the run's transcript. */
  onOpenTranscript: (run: LoopRunDto) => void;
  /** The run a link pointed at (`?run=`), marked when it is in this list. */
  highlightRunId?: string | null;
}

/** A Loop's runs, newest first, one line each, laid out like a detector's runs. */
export function LoopRunsTable({ runs, onOpenTranscript, highlightRunId }: LoopRunsTableProps) {
  return (
    <table className="data-table w-full">
      <thead className="sticky top-0 bg-background">
        <tr className="border-b border-border">
          <th className={cn(DETECTOR_TH, "w-[160px]")}>Timestamp</th>
          <th className={cn(DETECTOR_TH, "w-[110px]")}>Run</th>
          <th className={cn(DETECTOR_TH, "w-[9rem]")}>Session ID</th>
          <th className={cn(DETECTOR_TH, "w-[80px]")}>Duration</th>
          <th className={cn(DETECTOR_TH, "w-[80px] text-right")}>Cost</th>
          <th className={DETECTOR_TH}>Summary</th>
          <th className={cn(DETECTOR_TH, "w-[90px] border-r-0")}>Status</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const ms = durationMs(run);
          const outcome = runOutcomeLabel(run.status, run.findingKeys.length);
          const linked = run.id === highlightRunId;
          return (
            <tr
              key={run.id}
              className={cn(
                "border-b border-border transition-colors hover:bg-muted",
                linked && "bg-muted",
              )}
              aria-current={linked ? "true" : undefined}
            >
              <td className={cn(DETECTOR_TD, "whitespace-nowrap text-muted-foreground")}>
                {formatDate(run.startedAt ?? run.createTime)}
              </td>
              <td className={cn(DETECTOR_TD, "max-w-[110px] truncate text-muted-foreground")}>
                <span className="tabular-nums">#{run.seq}</span>
                {run.trigger === "manual" ? " · Manual" : " · Schedule"}
              </td>
              {run.sessionId ? (
                <IdCell
                  id={run.sessionId}
                  title={`${run.sessionId} — open the transcript of run #${run.seq}`}
                  onOpen={() => onOpenTranscript(run)}
                />
              ) : (
                <EmptyIdCell />
              )}
              <td className={cn(DETECTOR_TD, "text-muted-foreground")}>
                {ms === null ? EMPTY : formatDuration(ms)}
              </td>
              <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
                {run.costUsd ? formatCost(run.costUsd) : EMPTY}
              </td>
              <td className={cn(DETECTOR_TD, "max-w-[400px] text-foreground")}>
                <SummaryText summary={run.error ?? run.summary ?? ""} />
              </td>
              <td
                className={cn(
                  DETECTOR_TD,
                  "border-r-0",
                  FAILED.has(run.status) ? "text-destructive" : "text-muted-foreground",
                )}
                title={outcome}
              >
                {runStatusShort(run.status)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
