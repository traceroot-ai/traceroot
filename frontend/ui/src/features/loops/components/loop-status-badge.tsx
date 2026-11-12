"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { LoopPauseReason, LoopStatus } from "@traceroot/core/loops/pure";
import { STATUS_LABEL, STATUS_TONE, pauseDetail, type LoopTone } from "../loop-display";

export const TONE_STYLES: Record<LoopTone, string> = {
  ok: "bg-success-soft text-success",
  alert: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-muted text-muted-foreground",
};

export const BADGE =
  "inline-flex min-w-[3.5rem] items-center justify-center rounded-[2px] border border-transparent px-1.5 py-0.5 text-[12px] font-medium";

interface LoopStatusBadgeProps {
  status: LoopStatus;
  pauseReason: LoopPauseReason | null;
  failureStreak: number;
  className?: string;
}

/** Active / Paused / Paused by system; the last opens the reason the system stopped the Loop. */
export function LoopStatusBadge({
  status,
  pauseReason,
  failureStreak,
  className,
}: LoopStatusBadgeProps) {
  const badgeClassName = cn(BADGE, TONE_STYLES[STATUS_TONE[status]], className);
  const detail = pauseDetail(status, pauseReason, failureStreak);
  if (detail === undefined) return <span className={badgeClassName}>{STATUS_LABEL[status]}</span>;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            badgeClassName,
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          {STATUS_LABEL[status]}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <p className="text-[12px] leading-relaxed text-muted-foreground">{detail}</p>
      </PopoverContent>
    </Popover>
  );
}
