"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getAvailableLLMModels } from "@/lib/api";
import { flattenAvailableModels, pickDefaultModel, type ResolvedModel } from "../lib/resolve-model";

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
  /**
   * Empty create/chat forms should auto-pick the first available live model.
   * Persisted edit forms opt out so default/legacy null model selections do not
   * become dirty just because the model catalog loaded.
   */
  autoSelectDefault?: boolean;
}

function modelKey(m: { id?: string; model?: string; source: string; provider: string }) {
  return `${m.source}:${m.provider}:${m.id ?? m.model}`;
}

function providersMatch(model: ResolvedModel, value: ModelSelection) {
  if (model.provider === value.provider) return true;
  if (model.source !== "system" || value.source !== "system") return false;
  const normalizedValueProvider = value.provider.toLowerCase();
  return (
    normalizedValueProvider === model.provider.toLowerCase() ||
    normalizedValueProvider === model.adapter.toLowerCase()
  );
}

function modelMatchesSelection(model: ResolvedModel, value: ModelSelection) {
  if (model.id !== value.model) return false;
  if (!value.provider) return true;
  return model.source === value.source && providersMatch(model, value);
}

export function ModelSelector({
  value,
  onChange,
  workspaceId,
  autoSelectDefault = true,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: !!workspaceId,
  });

  // BYOK models first, then system models. No deduplication.
  const models = flattenAvailableModels(data, { includeFallback: false });
  const selectableModels = models.filter((m) => m.supported !== false);
  const isLoadingModels = !!workspaceId && isLoading;
  const hasModelLoadError = !!workspaceId && isError;
  const hasReturnedModels = models.length > 0;
  const hasUnsupportedOnlyModelList = !!data && hasReturnedModels && selectableModels.length === 0;
  const hasLoadedEmptyModelList = !!data && !hasReturnedModels;

  // Reconcile the incoming selection against the catalog:
  //   1. exact match on (model, provider, source) → check adapter; backfill if empty/wrong
  //   2. model-id-only match (legacy/hydrated state where the parent only has
  //      `model` saved, e.g. `project.rca_model: string`) → backfill the rest
  //   3. no match → preserve the current selection if the user already picked
  //      one, and only auto-pick a default when the model is still empty.
  // Without case 2 the selector would silently auto-pick a default when a
  // partially-hydrated saved selection arrives, clobbering the user's choice.
  useEffect(() => {
    if (selectableModels.length === 0) return;

    const exact = selectableModels.find((m) => modelMatchesSelection(m, value));
    const modelOnly =
      !exact && value.model && !value.provider
        ? selectableModels.find((m) => m.id === value.model)
        : null;
    const match = exact ?? modelOnly;

    if (!match) {
      if (autoSelectDefault && !value.model) {
        const pick = pickDefaultModel(selectableModels);
        if (pick) {
          onChange({
            model: pick.id,
            provider: pick.provider,
            source: pick.source,
            adapter: pick.adapter,
          });
        }
      }
      return;
    }

    // Match found — backfill any stale/empty fields (notably `adapter`, which
    // legacy selections often store as `""` and which `currentExists`-style
    // checks elsewhere ignore).
    if (
      autoSelectDefault &&
      (match.id !== value.model ||
        match.provider !== value.provider ||
        match.source !== value.source ||
        match.adapter !== value.adapter)
    ) {
      onChange({
        model: match.id,
        provider: match.provider,
        source: match.source,
        adapter: match.adapter,
      });
    }
  }, [selectableModels, value, onChange, autoSelectDefault]);

  const selectedKey = modelKey({ id: value.model, source: value.source, provider: value.provider });
  const selectedModel = selectableModels.find((m) => modelMatchesSelection(m, value));
  const selectedModelKey = selectedModel ? modelKey(selectedModel) : selectedKey;

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-sm px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {selectedModel?.label ||
              value.model ||
              (hasModelLoadError
                ? "Models unavailable"
                : hasUnsupportedOnlyModelList
                  ? "No supported models"
                  : hasLoadedEmptyModelList
                    ? "No model configured"
                    : isLoadingModels
                      ? "Loading models..."
                      : "Select model")}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="z-[70] max-h-[320px] w-[280px] overflow-y-auto p-1"
          sideOffset={4}
        >
          {selectableModels.map((m) => {
            const key = modelKey(m);
            const isSelected = key === selectedModelKey;
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
                </span>
                {showProvider && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{m.provider}</span>
                )}
              </button>
            );
          })}
          {selectableModels.length === 0 && (
            <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
              {isLoadingModels ? (
                "Loading models..."
              ) : hasModelLoadError ? (
                <div className="space-y-1.5">
                  <p>Unable to load models</p>
                  <p>Refresh the page, or check the workspace model provider configuration.</p>
                  {workspaceId && (
                    <Link
                      href={`/workspaces/${workspaceId}/settings/model-providers`}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      Configure model providers
                    </Link>
                  )}
                </div>
              ) : hasUnsupportedOnlyModelList ? (
                <div className="space-y-1.5">
                  <p>No supported models</p>
                  <p>
                    A provider is configured, but none of its models are currently supported by
                    Traceroot.
                  </p>
                  {workspaceId && (
                    <Link
                      href={`/workspaces/${workspaceId}/settings/model-providers`}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      Configure model providers
                    </Link>
                  )}
                </div>
              ) : hasLoadedEmptyModelList ? (
                <div className="space-y-1.5">
                  <p>No model configured</p>
                  <p>
                    Self-hosted deployments need an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the
                    server environment, or a BYOK provider.
                  </p>
                  {workspaceId && (
                    <Link
                      href={`/workspaces/${workspaceId}/settings/model-providers`}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      Configure model providers
                    </Link>
                  )}
                </div>
              ) : (
                "No models available"
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
