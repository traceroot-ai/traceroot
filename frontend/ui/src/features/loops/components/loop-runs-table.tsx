"use client";

import { MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExpandableSection } from "@/components/ui/expandable-section";
import { cn, formatCost, formatDate, formatRelativeTime } from "@/lib/utils";
import { DETECTOR_TD, DETECTOR_TH } from "@/features/detectors/components/detector-table-cells";
import type { LoopRunDto } from "@traceroot/core/loops/pure";
import { RUN_STATUS_TONE, runOutcomeLabel } from "../loop-display";
import { BADGE, TONE_STYLES } from "./loop-status-badge";

/** Runs with nothing to read: a quiet run or a pre-check skip. Two or more in a row fold into a group. */
const FOLDABLE = new Set(["quiet", "skipped_precheck"]);

type Row = { kind: "run"; run: LoopRunDto } | { kind: "group"; runs: LoopRunDto[] };

/** Newest-first runs with each stretch of two or more foldable runs collapsed into one group. */
export function groupRuns(runs: LoopRunDto[]): Row[] {
  const rows: Row[] = [];
  let stretch: LoopRunDto[] = [];
  const flush = () => {
    if (stretch.length >= 2) rows.push({ kind: "group", runs: stretch });
    else stretch.forEach((run) => rows.push({ kind: "run", run }));
    stretch = [];
  };
  for (const run of runs) {
    if (FOLDABLE.has(run.status)) stretch.push(run);
    else {
      flush();
      rows.push({ kind: "run", run });
    }
  }
  flush();
  return rows;
}

function duration(run: LoopRunDto): string {
  // A skipped run did no work: it has a start but no duration worth showing.
  if (!run.startedAt || !run.finishedAt || run.status.startsWith("skipped")) return "—";
  const seconds = Math.max(
    0,
    Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000),
  );
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

interface LoopRunsTableProps {
  runs: LoopRunDto[];
  /** Opens the run's transcript; absent when the host cannot show one. */
  onOpenTranscript: (run: LoopRunDto) => void;
}

function RunRows({ runs, onOpenTranscript }: LoopRunsTableProps) {
  return (
    <>
      {runs.map((run) => {
        const detail = run.error ?? run.summary;
        return (
          <tr key={run.id} className="border-b border-border align-top">
            <td className={cn(DETECTOR_TD, "tabular-nums text-muted-foreground")}>
              #{run.seq}
              {run.trigger === "manual" && (
                <span className="ml-1.5 rounded-[2px] bg-muted px-1 text-[11px]">Manual</span>
              )}
            </td>
            <td className={cn(DETECTOR_TD, "whitespace-normal")}>
              <span
                className={cn(BADGE, "justify-start", TONE_STYLES[RUN_STATUS_TONE[run.status]])}
              >
                {runOutcomeLabel(run.status, run.findingKeys.length)}
              </span>
              {detail && (
                <p
                  className={cn(
                    "mt-1 max-w-[34rem] text-[12px] leading-snug",
                    run.error ? "text-danger" : "text-muted-foreground",
                  )}
                >
                  {detail}
                </p>
              )}
            </td>
            <td
              className={cn(DETECTOR_TD, "text-muted-foreground")}
              title={run.startedAt ? formatRelativeTime(run.startedAt) : undefined}
            >
              {run.startedAt ? formatDate(run.startedAt) : "Not started"}
            </td>
            <td className={cn(DETECTOR_TD, "text-muted-foreground")}>{duration(run)}</td>
            <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
              {run.findingKeys.length || "—"}
            </td>
            <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
              {run.tracesRead || "—"}
            </td>
            <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
              {formatCost(run.costUsd)}
            </td>
            <td className={cn(DETECTOR_TD, "text-right")}>
              {run.sessionId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                  aria-label={`Open the transcript of run ${run.seq}`}
                  onClick={() => onOpenTranscript(run)}
                >
                  <MessagesSquare className="h-3.5 w-3.5" />
                  Transcript
                </Button>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

const HEAD = (
  <thead className="sticky top-0 bg-background">
    <tr className="border-b border-border">
      <th className={cn(DETECTOR_TH, "w-[90px]")}>Run</th>
      <th className={DETECTOR_TH}>Outcome</th>
      <th className={cn(DETECTOR_TH, "w-[170px]")}>Started</th>
      <th className={cn(DETECTOR_TH, "w-[90px]")}>Duration</th>
      <th className={cn(DETECTOR_TH, "w-[80px] text-right")}>Findings</th>
      <th className={cn(DETECTOR_TH, "w-[100px] text-right")}>Traces read</th>
      <th className={cn(DETECTOR_TH, "w-[80px] text-right")}>Cost</th>
      <th className="w-[120px] px-2 py-1.5">
        <span className="sr-only">Transcript</span>
      </th>
    </tr>
  </thead>
);

/** A Loop's runs. A quiet run is the normal outcome, so stretches of them fold away. */
export function LoopRunsTable({ runs, onOpenTranscript }: LoopRunsTableProps) {
  return (
    <table className="data-table w-full">
      {HEAD}
      <tbody>
        {groupRuns(runs).map((row) =>
          row.kind === "run" ? (
            <RunRows key={row.run.id} runs={[row.run]} onOpenTranscript={onOpenTranscript} />
          ) : (
            <tr key={`group-${row.runs[0].id}`} className="border-b border-border">
              <td colSpan={8} className="px-3 py-1.5">
                <ExpandableSection defaultOpen={false} title={groupTitle(row.runs)}>
                  <table className="data-table w-full">
                    <tbody>
                      <RunRows runs={row.runs} onOpenTranscript={onOpenTranscript} />
                    </tbody>
                  </table>
                </ExpandableSection>
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function groupTitle(runs: LoopRunDto[]): string {
  const skipped = runs.filter((r) => r.status === "skipped_precheck").length;
  const quiet = runs.length - skipped;
  const parts = [
    quiet > 0 ? `${quiet} quiet ${quiet === 1 ? "run" : "runs"}` : null,
    skipped > 0 ? `${skipped} skipped (no new traces)` : null,
  ].filter(Boolean);
  const newest = runs[0].startedAt ?? runs[0].createTime;
  return `${parts.join(" · ")} · latest ${formatRelativeTime(newest)}`;
}
