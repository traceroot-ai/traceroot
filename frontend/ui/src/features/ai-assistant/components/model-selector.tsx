"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SYSTEM_MODELS } from "@traceroot/core";
import { getAvailableLlmModels, type AvailableLlmModel } from "@/lib/api";

export interface ModelSelection {
  model: string;
  provider: string;
  source: "system" | "byok";
}

interface ModelSelectorProps {
  value: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  workspaceId?: string;
}

// Flatten all system models into a single list with provider info attached
const FALLBACK_MODELS = SYSTEM_MODELS.flatMap((s) =>
  s.models.map((m) => ({ ...m, provider: s.provider, source: "system" as const })),
);

export function ModelSelector({ value, onChange, workspaceId }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLlmModels(workspaceId!),
    enabled: !!workspaceId,
  });

  // Build flat model list: system models + BYOK-only models (deduplicated)
  const models: (AvailableLlmModel & { provider: string; source: "system" | "byok" })[] = (() => {
    if (!data) return FALLBACK_MODELS;
    const systemList = data.systemModels.flatMap((g) =>
      g.models.map((m) => ({ ...m, provider: g.provider, source: "system" as const })),
    );
    const systemIds = new Set(systemList.map((m) => m.id));
    const byokList = data.byokProviders.flatMap((g) =>
      g.models
        .filter((m) => !systemIds.has(m.id)) // skip duplicates of system models
        .map((m) => ({ ...m, provider: g.provider, source: "byok" as const })),
    );
    return [...byokList, ...systemList];
  })();

  const selectedModel = models.find((m) => m.id === value.model);

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-sm px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {selectedModel?.label || value.model || "Select model"}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="max-h-[320px] w-[220px] overflow-y-auto p-1"
          sideOffset={4}
        >
          {models.map((m) => (
            <button
              key={m.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-muted/50",
                m.id === value.model && "font-medium text-foreground",
              )}
              onClick={() => {
                onChange({ model: m.id, provider: m.provider, source: m.source });
                setOpen(false);
              }}
            >
              {m.id === value.model && <span className="text-[11px]">&#10003;</span>}
              {m.label}
            </button>
          ))}
          {models.length === 0 && (
            <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
              No models available
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
