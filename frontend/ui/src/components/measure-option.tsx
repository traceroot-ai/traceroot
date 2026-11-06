"use client";

import { SelectItem } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MeasureDoc } from "@/lib/measure-doc";

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

interface MeasureOptionProps {
  value: string;
  label: string;
  typeLabel: string;
  doc: MeasureDoc | undefined;
  icon?: React.ReactNode;
}

/**
 * A Measure dropdown row with the measure's unit, type and description on
 * hover, shared by the alert form and the widget builder. Tooltip content
 * portals to the body, so the forms' scroll containers cannot clip it. Render
 * inside a TooltipProvider.
 */
export function MeasureOption({ value, label, typeLabel, doc, icon }: MeasureOptionProps) {
  const item = (
    <SelectItem value={value} className="text-[12px]" icon={icon}>
      {label}
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
        <p className="text-[13px] font-medium">{label}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <MetaChip>Unit: {doc.unit}</MetaChip>
          <MetaChip>Type: {typeLabel}</MetaChip>
        </div>
        <p className="mt-2 text-[12px] leading-snug text-muted-foreground">{doc.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}
