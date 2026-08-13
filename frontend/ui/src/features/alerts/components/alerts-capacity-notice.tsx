"use client";

import { cn } from "@/lib/utils";
import { isAtAlertCapacity, type AlertCapacity } from "../capacity";

export interface AlertsCapacityNoticeProps {
  capacity?: AlertCapacity;
  className?: string;
}

// The create control is disabled at the cap, and a disabled button takes no
// pointer events, so the reason has to be text beside it rather than a tooltip.
export function AlertsCapacityNotice({ capacity, className }: AlertsCapacityNoticeProps) {
  if (!capacity || !isAtAlertCapacity(capacity)) return null;

  return (
    <p className={cn("text-[12px]", className)}>
      This project has {capacity.used} of {capacity.max} alerts. Delete one to make room — paused
      alerts still count toward the limit.
    </p>
  );
}
