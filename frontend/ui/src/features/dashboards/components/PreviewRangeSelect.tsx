"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RANGE_PRESETS, findRangePreset } from "../range-presets";

// The preview-window picker. Extracted from the widget builder so the alert
// form's preview offers the identical presets, label and default.
export function PreviewRangeSelect({
  rangeId,
  onRangeChange,
}: {
  rangeId: string;
  onRangeChange: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[12px]">
          {findRangePreset(rangeId).label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {RANGE_PRESETS.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            className="text-[12px]"
            onClick={() => onRangeChange(preset.id)}
          >
            {preset.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
