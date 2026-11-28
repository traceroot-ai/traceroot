"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { cn, formatCost, formatDate, formatRelativeTime } from "@/lib/utils";
import { DETECTOR_TD, DETECTOR_TH } from "@/features/detectors/components/detector-table-cells";
import type { Loop } from "../hooks/use-loops";
import { useBrowserTimezone, useNow } from "../hooks/use-now";
import {
  describeSchedule,
  nextRunLabel,
  nextRunTitle,
  runOutcomeLabel,
  scheduleZoneTitle,
} from "../loop-display";
import { loopSignalsHref } from "../signals-href";
import { LoopActionsMenu } from "./loop-actions-menu";
import { LoopStatusBadge } from "./loop-status-badge";

/** A count that opens what it counts, without also opening the row. */
function CountLink({ href, label, value }: { href: string; label: string; value: number }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      onClick={(e) => e.stopPropagation()}
      className="hover:text-foreground hover:underline"
    >
      {value}
    </Link>
  );
}

interface LoopsTableProps {
  loops: Loop[];
  projectId: string;
  onToggleStatus: (loop: Loop) => void;
  onDelete: (loop: Loop) => void;
  isStatusPending: boolean;
}

export function LoopsTable({
  loops,
  projectId,
  onToggleStatus,
  onDelete,
  isStatusPending,
}: LoopsTableProps) {
  const router = useRouter();
  const now = useNow();
  const viewerZone = useBrowserTimezone();

  return (
    <table className="data-table w-full">
      <thead>
        <tr className="border-b border-border">
          <th className={cn(DETECTOR_TH, "w-[140px]")}>Status</th>
          <th className={DETECTOR_TH}>Name</th>
          <th className={cn(DETECTOR_TH, "w-[240px]")}>Schedule</th>
          <th className={cn(DETECTOR_TH, "w-[120px]")}>Next run</th>
          <th className={cn(DETECTOR_TH, "w-[180px]")}>Last run</th>
          <th className={cn(DETECTOR_TH, "w-[200px]")}>Last result</th>
          <th className={cn(DETECTOR_TH, "w-[80px] text-right")}>Runs</th>
          <th className={cn(DETECTOR_TH, "w-[90px] text-right")}>Avg cost</th>
          <th className={cn(DETECTOR_TH, "w-[80px] text-right")}>Signals</th>
          <th className="col-sticky-end-head w-[56px] whitespace-nowrap px-2 py-1.5 text-right text-[12px] font-medium text-muted-foreground">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {loops.map((loop) => {
          const stopped = loop.status !== "active";
          const zone = loop.schedule.kind === "interval" ? null : loop.schedule.timezone;
          const last = loop.lastRun;
          const lastAt = last ? (last.startedAt ?? last.createTime) : null;
          const next = loop.status === "active" && loop.nextRunAt ? new Date(loop.nextRunAt) : null;
          return (
            <tr
              key={loop.id}
              onClick={() => router.push(`/projects/${projectId}/loops/${loop.id}`)}
              className={cn(
                "cursor-pointer border-b border-border transition-colors hover:bg-muted",
                stopped && "opacity-50",
              )}
            >
              <td className={DETECTOR_TD}>
                <LoopStatusBadge
                  className="justify-start"
                  status={loop.status}
                  failureStreak={loop.failureStreak}
                />
              </td>
              <td className={cn(DETECTOR_TD, "text-foreground")}>
                {loop.name}
                {loop.dryRun && <Badge className="ml-2">Dry run</Badge>}
              </td>
              <td
                className={cn(DETECTOR_TD, "text-muted-foreground")}
                title={scheduleZoneTitle(loop.schedule)}
              >
                {now && describeSchedule(loop.schedule, now)}
              </td>
              {/* How soon in the cell, the exact time in its title; empty while paused. */}
              <td
                className={cn(DETECTOR_TD, "text-muted-foreground")}
                title={next ? nextRunTitle(next, zone, viewerZone) : undefined}
              >
                {next && now && nextRunLabel(next, now)}
              </td>
              {/* The time in the cell, how long ago in its title. */}
              <td
                className={cn(DETECTOR_TD, "text-muted-foreground")}
                title={lastAt ? formatRelativeTime(lastAt) : undefined}
              >
                {lastAt ? formatDate(lastAt) : "Never"}
              </td>
              <td
                className={cn(DETECTOR_TD, "text-muted-foreground")}
                title={last ? (last.error ?? last.summary ?? undefined) : undefined}
              >
                {last && runOutcomeLabel(last.status, last.findingKeys.length)}
              </td>
              <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
                {loop.runCount}
              </td>
              <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
                {loop.avgCostUsd ? formatCost(loop.avgCostUsd) : "—"}
              </td>
              <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
                <CountLink
                  href={loopSignalsHref(projectId, loop.name)}
                  label={`View signals found by ${loop.name}`}
                  value={loop.signalCount}
                />
              </td>
              <td className="col-sticky-end px-2 text-right">
                <LoopActionsMenu
                  projectId={projectId}
                  loop={loop}
                  onToggleStatus={() => onToggleStatus(loop)}
                  onDelete={() => onDelete(loop)}
                  isStatusPending={isStatusPending}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
