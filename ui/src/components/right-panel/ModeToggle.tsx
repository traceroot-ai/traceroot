'use client';

import React from 'react';
import { RiRobot2Line } from "react-icons/ri";
import { Telescope, FileCode2 } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type ViewType = 'log' | 'agent' | 'trace';

interface ModeToggleProps {
  viewType: ViewType;
  onViewTypeChange: (type: ViewType) => void;
}

export default function ModeToggle({ viewType, onViewTypeChange }: ModeToggleProps) {
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
        <ToggleGroupItem value="agent" aria-label="Toggle agent view">
          <RiRobot2Line size={22} />
        </ToggleGroupItem>
        <ToggleGroupItem value="trace" aria-label="Toggle trace view">
          <Telescope size={22} />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
