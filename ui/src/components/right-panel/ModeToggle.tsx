"use client";

import React from "react";
import { Telescope, FileCode2 } from "lucide-react";
import { RiRobot2Line } from "react-icons/ri";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toggle } from "@/components/ui/toggle";

export type ViewType = "log" | "trace";

interface ModeToggleProps {
  viewType: ViewType;
  onViewTypeChange: (type: ViewType) => void;
  agentOpen?: boolean;
  onAgentToggle?: () => void;
}

export default function ModeToggle({
  viewType,
  onViewTypeChange,
  agentOpen = false,
  onAgentToggle,
}: ModeToggleProps) {
  return (
    <div className="flex justify-end items-center p-4 gap-3">
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
      {onAgentToggle && (
        <Toggle
          pressed={agentOpen}
          onPressedChange={onAgentToggle}
          aria-label="Toggle agent panel"
          variant="outline"
          size="lg"
        >
          <RiRobot2Line size={22} />
        </Toggle>
      )}
    </div>
  );
}
