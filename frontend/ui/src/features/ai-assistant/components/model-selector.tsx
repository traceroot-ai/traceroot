"use client";

import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SYSTEM_MODELS, PROVIDER_PRIORITY } from "@traceroot/core";
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
  s.models.map((m) => ({
    ...m,
    provider: s.provider,
    adapter: s.piAIProvider,
    source: "system" as const,
    supported: true,
  })),
);

function modelKey(m: { id?: string; model?: string; source: string; provider: string }) {
  return `${m.source}:${m.provider}:${m.id ?? m.model}`;
}

export function ModelSelector({ value, onChange, workspaceId }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: !!workspaceId,
  });

  // Build flat model list: BYOK models first, then system models. No deduplication.
  const models: (AvailableLLMModel & {
    provider: string;
    adapter: string;
    source: "system" | "byok";
  })[] = (() => {
    if (!data) return FALLBACK_MODELS;
    const systemList = data.systemModels.flatMap((g) =>
      g.models.map((m) => ({
        ...m,
        provider: g.provider,
        adapter: g.adapter,
        source: "system" as const,
        supported: true,
      })),
    );
    const byokList = data.byokProviders.flatMap((g) =>
      g.models.map((m) => ({
        ...m,
        provider: g.provider,
        adapter: g.adapter,
        source: "byok" as const,
      })),
    );
    return [...byokList, ...systemList];
  })();

  // Auto-select the best available model if current selection is not in the list.
  // This handles: initial empty state, provider becoming unavailable, and the
  // transition from FALLBACK_MODELS to real API data.
  useEffect(() => {
    if (models.length === 0) return;
    const currentExists = models.some(
      (m) => m.id === value.model && m.provider === value.provider && m.source === value.source,
    );
    if (!currentExists) {
      // Pick the first model from the highest-priority provider.
      // Walk the priority list and return the first model we find.
      let found = false;
      for (const adapter of PROVIDER_PRIORITY) {
        const match = models.find((m) => m.adapter === adapter);
        if (match) {
          onChange({ model: match.id, provider: match.provider, source: match.source });
          found = true;
          break;
        }
      }
      // If no priority match, fall back to the first model in the list
      if (!found && models[0]) {
        onChange({ model: models[0].id, provider: models[0].provider, source: models[0].source });
      }
    }
  }, [models, value, onChange]);

  const selectedKey = modelKey({ id: value.model, source: value.source, provider: value.provider });
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
          className="z-[70] max-h-[320px] w-[280px] overflow-y-auto p-1"
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
                  {m.source === "byok" && !m.supported && (
                    <span className="text-[10px] text-yellow-600">(unsupported)</span>
                  )}
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
