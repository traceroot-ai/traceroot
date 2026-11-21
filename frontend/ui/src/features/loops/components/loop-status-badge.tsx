"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { LoopStatus } from "@traceroot/core/loops/pure";
// The Alerts list's pills, so a loop's status reads like an alert's.
import { TonePill, TonePillButton } from "@/features/alerts/components/tone-pill";
import { STATUS_LABEL, STATUS_TONE, pauseDetail } from "../loop-display";

interface LoopStatusBadgeProps {
  status: LoopStatus;
  failureStreak: number;
  className?: string;
}

/** Active / Paused / Paused by system; the last opens the reason the system stopped the loop. */
export function LoopStatusBadge({ status, failureStreak, className }: LoopStatusBadgeProps) {
  const tone = STATUS_TONE[status];
  const detail = pauseDetail(status, failureStreak);
  if (detail === undefined) {
    return (
      <TonePill tone={tone} className={className}>
        {STATUS_LABEL[status]}
      </TonePill>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <TonePillButton
          tone={tone}
          className={className}
          // The badge sits in a clickable table row; opening the reason must not open the loop.
          onClick={(e) => e.stopPropagation()}
        >
          {STATUS_LABEL[status]}
        </TonePillButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3" onClick={(e) => e.stopPropagation()}>
        <p className="text-[12px] leading-relaxed text-muted-foreground">{detail}</p>
      </PopoverContent>
    </Popover>
  );
}
