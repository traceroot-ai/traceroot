"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  resolveAlertDeliveryFix,
  resolveAlertDisplayState,
  type AlertDisplayInput,
  type AlertTone,
} from "./alert-display";

const TONE_STYLES: Record<AlertTone, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  alert: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  // neutral-950 would vanish against the dark page background, hence 800
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400",
};

const BADGE = "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium";

export interface AlertSeverityBadgeProps extends AlertDisplayInput {
  /** Omitted by callers with no workspace in hand: the reason still shows, the link does not. */
  workspaceId?: string;
}

export function AlertSeverityBadge({ workspaceId, ...alert }: AlertSeverityBadgeProps) {
  const { label, tone, detail } = resolveAlertDisplayState(alert);
  const className = cn(BADGE, TONE_STYLES[tone]);

  if (detail === undefined) {
    return <span className={className}>{label}</span>;
  }

  const fix = resolveAlertDeliveryFix(alert);
  const fixHref =
    fix && workspaceId ? `/workspaces/${workspaceId}/settings/${fix.settingsPage}` : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            className,
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 p-3">
        <p className="text-[12px] leading-relaxed text-muted-foreground">{detail}</p>
        {fixHref && fix && (
          <Link
            href={fixHref}
            className="inline-flex items-center gap-1 text-[12px] font-medium hover:underline"
          >
            {fix.label}
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </PopoverContent>
    </Popover>
  );
}
