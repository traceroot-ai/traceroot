"use client";

import { cn } from "@/lib/utils";
import { isAtAlertCapacity, type AlertCapacity } from "../capacity";
import { useT } from "@/lib/i18n/provider";

export interface AlertsCapacityNoticeProps {
  capacity?: AlertCapacity;
  className?: string;
}

// The create control is disabled at the cap, and a disabled button takes no
// pointer events, so the reason has to be text beside it rather than a tooltip.
export function AlertsCapacityNotice({ capacity, className }: AlertsCapacityNoticeProps) {
  const t = useT();
  if (!capacity || !isAtAlertCapacity(capacity)) return null;

  return (
    <p className={cn("text-[12px]", className)}>
      {t("alertsList.atCapacity", { used: capacity.used, max: capacity.max })}
    </p>
  );
}
