"use client";

import { SelectItem } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MEASURE_TYPE_LABEL, type AlertMeasureDoc } from "../measure-docs";
import type { AlertMeasure } from "../rule-model";

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

interface MeasureOptionProps {
  measure: AlertMeasure;
  doc: AlertMeasureDoc | undefined;
}

/**
 * A Measure dropdown row with the measure's unit, type and description on
 * hover. Tooltip content portals to the body, so the two-column layout's
 * scroll containers cannot clip it.
 */
export function MeasureOption({ measure, doc }: MeasureOptionProps) {
  const item = (
    <SelectItem value={measure.id} className="text-[12px]">
      {measure.label}
    </SelectItem>
  );
  if (!doc) return item;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="w-64 border bg-popover p-3 text-popover-foreground shadow-md"
      >
        <p className="text-[13px] font-medium">{measure.label}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <MetaChip>Unit: {doc.unit}</MetaChip>
          <MetaChip>Type: {MEASURE_TYPE_LABEL[measure.type]}</MetaChip>
        </div>
        <p className="mt-2 text-[12px] leading-snug text-muted-foreground">{doc.description}</p>
        {doc.unavailable && (
          <p className="mt-2 border-t border-border pt-2 text-[11px] leading-snug text-muted-foreground">
            {doc.unavailable}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
