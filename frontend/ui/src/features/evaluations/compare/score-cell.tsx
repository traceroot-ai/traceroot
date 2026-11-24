"use client";

/**
 * How a scorer cell reads in the comparison table: the recorded value in the column's
 * format, and the marker for values the comparison would not compare (its change is
 * `cellDelta`, in `./cell-state`).
 */
import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MISMATCH } from "./cell-state";
import { formatMetricValue } from "./metric-format";
import type { ScorerColumn } from "./model";

/** A recorded score as the column shows it. A categorical column's values are labels, so
 *  they show as recorded, never rounded. */
export function formatScore(value: number | boolean | string, column: ScorerColumn): string {
  if (typeof value === "string" || column.valueType === "categorical") return String(value);
  return formatMetricValue(typeof value === "boolean" ? (value ? 1 : 0) : value, column.format);
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
