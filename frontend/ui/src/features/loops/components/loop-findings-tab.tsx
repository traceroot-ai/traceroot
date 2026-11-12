"use client";

import Link from "next/link";
import { cn, formatDate } from "@/lib/utils";
import { DETECTOR_TD, DETECTOR_TH } from "@/features/detectors/components/detector-table-cells";
import type { LoopFindingDto } from "@traceroot/core/loops/pure";
import { BADGE, TONE_STYLES } from "./loop-status-badge";
import type { LoopTone } from "../loop-display";

const STATUS_TONE: Record<string, LoopTone> = {
  open: "alert",
  resolved: "ok",
  dismissed: "neutral",
};

interface LoopFindingsTabProps {
  projectId: string;
  findings: LoopFindingDto[];
  dryRun: boolean;
}

/** The signals this Loop created. Each opens on the Signals page, where status and RCA live. */
export function LoopFindingsTab({ projectId, findings, dryRun }: LoopFindingsTabProps) {
  if (findings.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-1.5 px-4 text-center">
        <p className="text-[13px] text-muted-foreground">No findings yet</p>
        <p className="max-w-md text-[12px] text-muted-foreground">
          {dryRun
            ? "This is a dry-run Loop: it records a summary for each run and writes no findings."
            : "A finding appears here, and under Signals, when a run records a recurring problem."}
        </p>
      </div>
    );
  }
  return (
    <table className="data-table w-full">
      <thead className="sticky top-0 bg-background">
        <tr className="border-b border-border">
          <th className={cn(DETECTOR_TH, "w-[100px]")}>Status</th>
          <th className={DETECTOR_TH}>Finding</th>
          <th className={cn(DETECTOR_TH, "w-[80px] text-right")}>Hits</th>
          <th className={cn(DETECTOR_TH, "w-[170px]")}>First seen</th>
          <th className={cn(DETECTOR_TH, "w-[170px]")}>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f) => (
          <tr key={f.signalId} className="border-b border-border align-top">
            <td className={DETECTOR_TD}>
              <span
                className={cn(
                  BADGE,
                  "justify-start capitalize",
                  TONE_STYLES[STATUS_TONE[f.status] ?? "neutral"],
                )}
              >
                {f.status}
              </span>
            </td>
            <td className={cn(DETECTOR_TD, "whitespace-normal")}>
              <Link
                href={`/projects/${projectId}/signals?signalId=${encodeURIComponent(f.signalId)}`}
                className="text-foreground hover:underline"
              >
                {f.title}
              </Link>
              <p className="mt-0.5 max-w-[40rem] text-[12px] leading-snug text-muted-foreground">
                {f.criteriaCovers}
              </p>
            </td>
            <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
              {f.hitCount}
            </td>
            <td className={cn(DETECTOR_TD, "text-muted-foreground")}>
              {formatDate(f.firstSeenAt)}
            </td>
            <td className={cn(DETECTOR_TD, "text-muted-foreground")}>{formatDate(f.lastSeenAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
