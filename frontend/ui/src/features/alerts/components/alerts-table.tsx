"use client";

import { useState } from "react";
import Link from "next/link";
import { MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, formatDate, formatRelativeTime } from "@/lib/utils";
import { DETECTOR_TH, DETECTOR_TD } from "@/features/detectors/components/detector-table-cells";
import type { AlertSummary } from "../hooks/use-alerts";
import { AlertSeverityBadge } from "./alert-severity-badge";
import { formatAlertWindow, resolveAlertDisplayState } from "./alert-display";

const ACTION_ITEM = "flex h-8 w-full items-center gap-2 rounded-[2px] px-2 text-[13px]";

interface AlertsTableProps {
  alerts: AlertSummary[];
  projectId: string;
  workspaceId?: string;
  onToggleStatus: (alert: AlertSummary) => void;
  onDelete: (alert: AlertSummary) => void;
  isStatusPending: boolean;
}

export function AlertsTable({
  alerts,
  projectId,
  workspaceId,
  onToggleStatus,
  onDelete,
  isStatusPending,
}: AlertsTableProps) {
  const [actionsOpen, setActionsOpen] = useState<string | null>(null);

  return (
    <table className="data-table w-full">
      <thead>
        <tr className="border-b border-border">
          <th className={cn(DETECTOR_TH, "w-[110px]")}>Status</th>
          <th className={DETECTOR_TH}>Name</th>
          <th className={cn(DETECTOR_TH, "w-[120px]")}>Window</th>
          <th className={cn(DETECTOR_TH, "w-[180px]")}>Last evaluated</th>
          <th className="col-sticky-end-head w-[56px] whitespace-nowrap px-2 py-1.5 text-right text-[12px] font-medium text-muted-foreground">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {alerts.map((alert) => {
          // Dimmed and offering "Resume" for parked as well as paused: both are
          // rules no tick will run, and the same write starts either one.
          const { isStopped } = resolveAlertDisplayState(alert);
          return (
            <tr
              key={alert.id}
              className={cn(
                "border-b border-border transition-colors hover:bg-muted",
                isStopped && "opacity-50",
              )}
            >
              <td className={DETECTOR_TD}>
                <AlertSeverityBadge
                  workspaceId={workspaceId}
                  status={alert.status}
                  severity={alert.severity}
                  lastError={alert.lastError}
                  lastEvaluatedAt={alert.lastEvaluatedAt}
                  lastNotifyStatus={alert.lastNotifyStatus}
                  lastNotifyError={alert.lastNotifyError}
                />
              </td>
              <td className={cn(DETECTOR_TD, "text-foreground")}>{alert.name}</td>
              <td className={cn(DETECTOR_TD, "text-muted-foreground")}>
                {formatAlertWindow(alert.window)}
              </td>
              <td
                className={cn(DETECTOR_TD, "text-muted-foreground")}
                title={
                  alert.lastEvaluatedAt ? formatRelativeTime(alert.lastEvaluatedAt) : undefined
                }
              >
                {alert.lastEvaluatedAt ? formatDate(alert.lastEvaluatedAt) : "Never"}
              </td>
              <td className="col-sticky-end px-2 text-right">
                <Popover
                  open={actionsOpen === alert.id}
                  onOpenChange={(open) => setActionsOpen(open ? alert.id : null)}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Actions for ${alert.name}`}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-36 p-1">
                    <button
                      className={cn(ACTION_ITEM, "hover:bg-muted disabled:opacity-50")}
                      disabled={isStatusPending}
                      onClick={() => {
                        onToggleStatus(alert);
                        setActionsOpen(null);
                      }}
                    >
                      {isStopped ? (
                        <Play className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Pause className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {isStopped ? "Resume" : "Pause"}
                    </button>
                    <Link
                      href={`/projects/${projectId}/alerts/${alert.id}`}
                      className={cn(ACTION_ITEM, "hover:bg-muted")}
                      onClick={() => setActionsOpen(null)}
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      Edit
                    </Link>
                    <button
                      className={cn(ACTION_ITEM, "text-destructive hover:bg-destructive/10")}
                      onClick={() => {
                        onDelete(alert);
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
