"use client";

/**
 * How a scorer cell reads, shared by the comparison table and the trace panel's scores:
 * the recorded value in the column's format, and the marker for values the comparison
 * would not compare (its change is `cellDelta`, in `./cell-state`).
 */
import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MISMATCH } from "./cell-state";
import { formatMetricValue } from "./metric-format";
import type { ScorerColumn } from "./model";

/** A recorded score as the column shows it. */
export function formatScore(value: number | boolean | string, column: ScorerColumn): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") {
    return column.valueType === "categorical"
      ? String(value)
      : formatMetricValue(value ? 1 : 0, column.format);
  }
  return formatMetricValue(value, column.format);
}

export function MismatchMarker({ reason }: { reason: keyof typeof MISMATCH }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-tooltip-trigger
          className="ml-1 cursor-default text-muted-foreground"
        >
          {MISMATCH[reason].label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[320px] text-left">
        {MISMATCH[reason].why}
      </TooltipContent>
    </Tooltip>
  );
}
