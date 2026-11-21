"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  resolveAlertDeliveryFix,
  resolveAlertDisplayState,
  type AlertDisplayInput,
} from "./alert-display";
import { TonePill, TonePillButton } from "./tone-pill";

export interface AlertSeverityBadgeProps extends AlertDisplayInput {
  /** Omitted by callers with no workspace in hand: the reason still shows, the link does not. */
  workspaceId?: string;
  className?: string;
}

export function AlertSeverityBadge({ workspaceId, className, ...alert }: AlertSeverityBadgeProps) {
  const { label, tone, detail } = resolveAlertDisplayState(alert);

  if (detail === undefined) {
    return (
      <TonePill tone={tone} className={className}>
        {label}
      </TonePill>
    );
  }

  const fix = resolveAlertDeliveryFix(alert);
  const fixHref =
    fix && workspaceId ? `/workspaces/${workspaceId}/settings/${fix.settingsPage}` : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <TonePillButton tone={tone} className={className}>
          {label}
        </TonePillButton>
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
