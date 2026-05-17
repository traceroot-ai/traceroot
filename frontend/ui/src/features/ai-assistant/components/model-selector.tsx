"use client";

import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getAvailableLLMModels } from "@/lib/api";
import { flattenAvailableModels, pickDefaultModel } from "../lib/resolve-model";

export interface ModelSelection {
  model: string;
  provider: string;
  source: "system" | "byok";
  adapter: string; // e.g. "anthropic" | "openai" — needed for SDK routing
}

interface ModelSelectorProps {
  value: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  workspaceId?: string;
}

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

  // BYOK models first, then system models. No deduplication.
  const models = flattenAvailableModels(data);

  // Reconcile the incoming selection against the catalog:
  //   1. exact match on (model, provider, source) → check adapter; backfill if empty/wrong
  //   2. model-id-only match (legacy/hydrated state where the parent only has
  //      `model` saved, e.g. `project.rca_model: string`) → backfill the rest
  //   3. no match → auto-pick a default
  // Without case 2 the selector would silently auto-pick a default when a
  // partially-hydrated saved selection arrives, clobbering the user's choice.
  useEffect(() => {
    if (models.length === 0) return;

    const exact = models.find(
      (m) => m.id === value.model && m.provider === value.provider && m.source === value.source,
    );
    const modelOnly =
      !exact && value.model && !value.provider ? models.find((m) => m.id === value.model) : null;
    const match = exact ?? modelOnly;

    if (!match) {
      const pick = pickDefaultModel(models);
      if (pick) {
        onChange({
          model: pick.id,
          provider: pick.provider,
          source: pick.source,
          adapter: pick.adapter,
        });
      }
      return;
    }

    // Match found — backfill any stale/empty fields (notably `adapter`, which
    // legacy selections often store as `""` and which `currentExists`-style
    // checks elsewhere ignore).
    if (
      match.id !== value.model ||
      match.provider !== value.provider ||
      match.source !== value.source ||
      match.adapter !== value.adapter
    ) {
      onChange({
        model: match.id,
        provider: match.provider,
        source: match.source,
        adapter: match.adapter,
      });
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
                  onChange({
                    model: m.id,
                    provider: m.provider,
                    source: m.source,
                    adapter: m.adapter,
                  });
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
