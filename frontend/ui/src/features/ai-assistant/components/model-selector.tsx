"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SYSTEM_MODELS } from "@traceroot/core";
import { getAvailableLLMModels, type AvailableLLMModel } from "@/lib/api";

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

function modelKey(m: { id: string; source: string; provider: string }) {
  return `${m.source}:${m.provider}:${m.id}`;
}

export function ModelSelector({ value, onChange, workspaceId }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: !!workspaceId,
  });

  // Build flat model list: BYOK models first, then system models. No deduplication.
  const models: (AvailableLLMModel & { provider: string; source: "system" | "byok" })[] = (() => {
    if (!data) return FALLBACK_MODELS;
    const systemList = data.systemModels.flatMap((g) =>
      g.models.map((m) => ({ ...m, provider: g.provider, source: "system" as const })),
    );
    const byokList = data.byokProviders.flatMap((g) =>
      g.models.map((m) => ({ ...m, provider: g.provider, source: "byok" as const })),
    );
    return [...byokList, ...systemList];
  })();

  const selectedKey = modelKey(value);
  const selectedModel = models.find((m) => modelKey(m) === selectedKey);

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
          className="max-h-[320px] w-[280px] overflow-y-auto p-1"
          sideOffset={4}
        >
          {models.map((m) => {
            const key = modelKey(m);
            const isSelected = key === selectedKey;
            // Show provider tag for BYOK models to distinguish from system ones
            const showProvider = m.source === "byok";
            return (
              <button
                key={key}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-muted/50",
                  isSelected && "font-medium text-foreground",
                )}
                onClick={() => {
                  onChange({ model: m.id, provider: m.provider, source: m.source });
                  setOpen(false);
                }}
              >
                <span className="flex items-center gap-1.5">
                  {isSelected && <span className="text-[11px]">&#10003;</span>}
                  {m.label}
                </span>
                {showProvider && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{m.provider}</span>
                )}
              </button>
            );
          })}
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
