"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
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
  /**
   * Interactive create flows that must reflect only workspace-configured models
   * can disable the compiled-in fallback used while the model catalog loads.
   */
  includeFallbackModels?: boolean;
  /**
   * Create flows can hide BYOK models Traceroot cannot run yet. Existing
   * selector consumers keep the historical behavior of showing them with an
   * unsupported badge.
   */
  hideUnsupportedModels?: boolean;
  /** Prefer a known detector/default model when it is present in the live catalog. */
  preferredDefaultModelId?: string;
  preferredDefaultModelSource?: "system" | "byok";
}

function modelKey(m: { id?: string; model?: string; source: string; provider: string }) {
  return `${m.source}:${m.provider}:${m.id ?? m.model}`;
}

export function ModelSelector({
  value,
  onChange,
  workspaceId,
  includeFallbackModels = true,
  hideUnsupportedModels = false,
  preferredDefaultModelId,
  preferredDefaultModelSource,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: !!workspaceId,
  });

  // BYOK models first, then system models. No deduplication.
  const models = flattenAvailableModels(data, { includeFallback: includeFallbackModels });
  const visibleModels = hideUnsupportedModels
    ? models.filter((m) => m.supported !== false)
    : models;
  const isLoadingModels = !!workspaceId && isLoading;
  const hasModelLoadError = !!workspaceId && isError;
  const hasReturnedModels = models.length > 0;
  const hasUnsupportedOnlyModelList =
    hideUnsupportedModels && !!data && hasReturnedModels && visibleModels.length === 0;
  const hasLoadedEmptyModelList = !!data && !hasReturnedModels;
  const modelStatusLabel = hasModelLoadError
    ? "Models unavailable"
    : hasUnsupportedOnlyModelList
      ? "No supported models"
      : hasLoadedEmptyModelList
        ? "No model configured"
        : isLoadingModels
          ? "Loading models..."
          : null;

  // Reconcile the incoming selection against the catalog:
  //   1. exact match on (model, provider, source) → check adapter; backfill if empty/wrong
  //   2. model-id-only match (legacy/hydrated state where the parent only has
  //      `model` saved, e.g. `project.rca_model: string`) → backfill the rest
  //   3. no match → preserve the current selection if the user already picked
  //      one, and only auto-pick a default when the model is still empty.
  // Without case 2 the selector would silently auto-pick a default when a
  // partially-hydrated saved selection arrives, clobbering the user's choice.
  useEffect(() => {
    if (visibleModels.length === 0) return;

    const exact = visibleModels.find(
      (m) => m.id === value.model && m.provider === value.provider && m.source === value.source,
    );
    const modelOnly =
      !exact && value.model && !value.provider
        ? visibleModels.find((m) => m.id === value.model)
        : null;
    const match = exact ?? modelOnly;

    if (!match) {
      if (!value.model) {
        const pick = pickDefaultModel(visibleModels, {
          preferredModelId: preferredDefaultModelId,
          preferredSource: preferredDefaultModelSource,
        });
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
  }, [visibleModels, value, onChange, preferredDefaultModelId, preferredDefaultModelSource]);

  const selectedKey = modelKey({ id: value.model, source: value.source, provider: value.provider });
  const selectedModel = visibleModels.find((m) => modelKey(m) === selectedKey);
  const selectedModelKey = selectedModel ? modelKey(selectedModel) : selectedKey;

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-sm px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {selectedModel?.label || modelStatusLabel || value.model || "Select model"}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="z-[70] max-h-[320px] w-[280px] overflow-y-auto p-1"
          sideOffset={4}
        >
          {visibleModels.map((m) => {
            const key = modelKey(m);
            const isSelected = key === selectedModelKey;
            // Show provider tag for BYOK models to distinguish from system ones
            const showProvider = m.source === "byok";
            return (
              <button
                type="button"
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
          {visibleModels.length === 0 && (
            <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
              {isLoadingModels ? (
                "Loading models..."
              ) : hasModelLoadError ? (
                <div className="space-y-1.5">
                  <p>Unable to load models</p>
                  <p>
                    Refresh the page. If you use BYOK, check Model Providers. If you rely on system
                    models, ask an admin to verify server env vars and workspace model catalog
                    availability.
                  </p>
                  {workspaceId && (
                    <Link
                      href={`/workspaces/${workspaceId}/settings/model-providers`}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      Configure BYOK providers
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
                      Configure BYOK providers
                    </Link>
                  )}
                </div>
              ) : hasLoadedEmptyModelList ? (
                <div className="space-y-1.5">
                  <p>No model configured</p>
                  <p>
                    Self-hosted deployments need an admin to set `ANTHROPIC_API_KEY` or
                    `OPENAI_API_KEY` in the server environment. To use a workspace-scoped key
                    instead, add a BYOK provider.
                  </p>
                  {workspaceId && (
                    <Link
                      href={`/workspaces/${workspaceId}/settings/model-providers`}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      Configure BYOK providers
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
