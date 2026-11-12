"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, formatCost, formatRelativeTime } from "@/lib/utils";
import { DETECTOR_TD, DETECTOR_TH } from "@/features/detectors/components/detector-table-cells";
import { serializeFiltersParam } from "@/features/filters/predicate";
import type { Loop } from "../hooks/use-loops";
import { describeSchedule, formatInZone, runOutcomeLabel } from "../loop-display";
import { LoopStatusBadge } from "./loop-status-badge";

const ACTION_ITEM = "flex h-8 w-full items-center gap-2 rounded-[2px] px-2 text-[13px]";

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
  const [actionsOpen, setActionsOpen] = useState<string | null>(null);

  return (
    <table className="data-table w-full">
      <thead>
        <tr className="border-b border-border">
          <th className={cn(DETECTOR_TH, "w-[140px]")}>Status</th>
          <th className={DETECTOR_TH}>Name</th>
          <th className={cn(DETECTOR_TH, "w-[240px]")}>Schedule</th>
          <th className={cn(DETECTOR_TH, "w-[170px]")}>Next run</th>
          <th className={cn(DETECTOR_TH, "w-[220px]")}>Last run</th>
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
          return (
            <tr
              key={loop.id}
              onClick={() => router.push(`/projects/${projectId}/loops/${loop.id}`)}
              className="cursor-pointer border-b border-border transition-colors hover:bg-muted"
            >
              <td className={DETECTOR_TD}>
                <LoopStatusBadge
                  className="justify-start"
                  status={loop.status}
                  pauseReason={loop.pauseReason}
                  failureStreak={loop.failureStreak}
                />
              </td>
              <td className={cn(DETECTOR_TD, "text-foreground", stopped && "opacity-70")}>
                {loop.name}
                {loop.dryRun && (
                  <span className="ml-2 rounded-[2px] bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    Dry run
                  </span>
                )}
              </td>
              <td className={cn(DETECTOR_TD, "text-muted-foreground")}>
                {describeSchedule(loop.schedule)}
              </td>
              <td className={cn(DETECTOR_TD, "text-muted-foreground")}>
                {loop.status === "active" && loop.nextRunAt
                  ? formatInZone(new Date(loop.nextRunAt), zone)
                  : "—"}
              </td>
              <td className={cn(DETECTOR_TD, "text-muted-foreground")}>
                {last ? (
                  <span title={last.error ?? last.summary ?? undefined}>
                    {runOutcomeLabel(last.status, last.findingKeys.length)}
                    <span className="ml-1.5 text-[11px]">
                      {formatRelativeTime(last.startedAt ?? last.createTime)}
                    </span>
                  </span>
                ) : (
                  "Never run"
                )}
              </td>
              <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
                {loop.runCount}
              </td>
              <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
                {formatCost(loop.avgCostUsd)}
              </td>
              <td className={cn(DETECTOR_TD, "text-right tabular-nums text-muted-foreground")}>
                <CountLink
                  href={`/projects/${projectId}/signals?${new URLSearchParams({
                    filters: serializeFiltersParam([
                      { field: "detector_id", op: "eq", value: loop.detectorId },
                    ])!,
                  })}`}
                  label={`View signals found by ${loop.name}`}
                  value={loop.signalCount}
                />
              </td>
              <td className="col-sticky-end px-2 text-right">
                <Popover
                  open={actionsOpen === loop.id}
                  onOpenChange={(open) => setActionsOpen(open ? loop.id : null)}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Actions for ${loop.name}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-36 p-1">
                    <button
                      className={cn(ACTION_ITEM, "hover:bg-muted disabled:opacity-50")}
                      disabled={isStatusPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleStatus(loop);
                        setActionsOpen(null);
                      }}
                    >
                      {stopped ? (
                        <Play className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Pause className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {stopped ? "Resume" : "Pause"}
                    </button>
                    <Link
                      href={`/projects/${projectId}/loops/${loop.id}/edit`}
                      className={cn(ACTION_ITEM, "hover:bg-muted")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActionsOpen(null);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      Edit
                    </Link>
                    <button
                      className={cn(ACTION_ITEM, "text-destructive hover:bg-destructive/10")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(loop);
                        setActionsOpen(null);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </PopoverContent>
                </Popover>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
