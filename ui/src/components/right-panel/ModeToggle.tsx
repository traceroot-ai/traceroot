"use client";

import React from "react";
import { Telescope, FileCode2 } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type ViewType = "log" | "trace";

interface ModeToggleProps {
  viewType: ViewType;
  onViewTypeChange: (type: ViewType) => void;
}

export default function ModeToggle({
  viewType,
  onViewTypeChange,
}: ModeToggleProps) {
  return (
    <div className="flex justify-end p-4">
      <ToggleGroup
        type="single"
        value={viewType}
        onValueChange={(value) => {
          if (value) onViewTypeChange(value as ViewType);
        }}
        variant="outline"
        size="lg"
      >
        <ToggleGroupItem value="log" aria-label="Toggle log view">
          <FileCode2 size={22} />
        </ToggleGroupItem>
        <ToggleGroupItem value="trace" aria-label="Toggle trace view">
          <Telescope size={22} />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
