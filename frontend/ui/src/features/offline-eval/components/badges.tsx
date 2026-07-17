"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getSpanKindColor } from "@/features/traces/components/SpanKindIcon";
import {
  granularity,
  goldenStatus,
  type Granularity,
  type GoldenStatus,
  type RowOutcome,
  type Severity,
} from "../types";
import { GOLDEN_VARIANT, OUTCOME_LABEL, OUTCOME_VARIANT, SEVERITY_VARIANT } from "../utils";

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge variant={SEVERITY_VARIANT[severity]} className="capitalize">
      {severity}
    </Badge>
  );
}

/**
 * Golden status with its definition attached — "Golden" is a claim about human
 * validation, and the tooltip is where that claim is stated rather than assumed.
 */
export function GoldenBadge({ status }: { status: GoldenStatus }) {
  const meta = goldenStatus(status);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Badge variant={GOLDEN_VARIANT[status]}>{meta.label}</Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          <p className="text-[11px] leading-snug">{meta.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Granularity chip, tinted with the same span-kind palette the trace viewer
 * uses, so "LLM response" reads violet here and violet in the span tree.
 */
export function ScopeBadge({
  scope,
  className,
  withTooltip = true,
}: {
  scope: Granularity;
  className?: string;
  withTooltip?: boolean;
}) {
  const meta = granularity(scope);
  const color = getSpanKindColor(meta.spanKind);

  const chip = (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none",
        color.surface,
        color.glyph,
        className,
      )}
    >
      {meta.label}
    </span>
  );

  if (!withTooltip) return chip;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {chip}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          <p className="text-[11px] leading-snug">{meta.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function OutcomeBadge({ outcome }: { outcome: RowOutcome }) {
  return <Badge variant={OUTCOME_VARIANT[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>;
}

/** Key=value cohort chip. */
export function CohortChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground">
      {label}={value}
    </span>
  );
}
