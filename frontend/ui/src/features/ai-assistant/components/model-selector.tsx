"use client";

import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { isDecisionAdapter } from "@traceroot/core";
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
   * System model id the parent falls back to when the selection is empty.
   * Setting it makes an empty selection a valid persistent state: the selector
   * never auto-picks into the parent's state, and presents that model as an
   * explicit pick of it would. Surfaces needing a concrete stored selection
   * leave this unset and get the auto-pick.
   */
  defaultModelId?: string;
  /** Whether to infer a provider for a saved selection that only has a model ID. */
  allowModelOnlyMatch?: boolean;
  /** List decision models (TypeSafe); only detector pickers set it. */
  allowDecisionModels?: boolean;
  /** Render the trigger as a full-width form field instead of the inline chip. */
  field?: boolean;
  disabled?: boolean;
}

function modelKey(m: { id?: string; model?: string; source: string; provider: string }) {
  return `${m.source}:${m.provider}:${m.id ?? m.model}`;
}

export function ModelSelector({
  value,
  onChange,
  workspaceId,
  defaultModelId,
  allowModelOnlyMatch = true,
  allowDecisionModels = false,
  field = false,
  disabled = false,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const { data, isPending } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: !!workspaceId,
  });

  // BYOK models first, then system models. No deduplication. Only shows the
  // compiled-in fallback list while the query is still pending — once settled,
  // an empty response means the workspace genuinely has no models.
  const models = flattenAvailableModels(data, isPending).filter(
    (m) => allowDecisionModels || !isDecisionAdapter(m.adapter),
  );

  // Reconcile the incoming selection against the catalog:
  //   1. exact match on (model, provider, source) → check adapter; backfill if empty/wrong
  //   2. model-id-only match (legacy/hydrated state where the parent only has
  //      `model` saved, e.g. `project.rca_model: string`) → backfill the rest
  //   3. no match → preserve the current selection if the user already picked
  //      one, and only auto-pick a default once the model is still empty and no
  //      `defaultModelId` marks "empty" as a valid persistent state.
  // The whole reconcile is skipped while the query is pending: `models` is still
  // the compiled-in fallback list then, so reconciling against it would backfill
  // a phantom provider onto a partially-hydrated selection (e.g. a legacy
  // `project.rca_model` with no provider), self-enabling a Save the user never
  // touched. Waiting for settled state means case 2 only ever matches real
  // models, and case 3 only auto-picks from real models.
  useEffect(() => {
    if (isPending) return;

    const exact = models.find(
      (m) => m.id === value.model && m.provider === value.provider && m.source === value.source,
    );
    // Prefer the selection's own source: the list is BYOK-first and not
    // deduplicated, so a bare id could bind a system selection to a BYOK
    // provider sharing that id — same name, different credentials at run time.
    const modelOnly =
      allowModelOnlyMatch && !exact && value.model && !value.provider
        ? (models.find((m) => m.id === value.model && m.source === value.source) ??
          models.find((m) => m.id === value.model))
        : null;
    const match = exact ?? modelOnly;

    if (!match) {
      if (!value.model && !defaultModelId) {
        const pick = pickDefaultModel(models);
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
  }, [models, value, onChange, isPending, defaultModelId, allowModelOnlyMatch]);

  // Present the tracked default as the selection so an unpinned parent reads
  // like one that stored this model. A BYOK selection with no model runs its
  // provider's model, not this one, so it tracks nothing here.
  const showsDefault = !value.model && value.source !== "byok" && !!defaultModelId;
  const defaultRow = showsDefault
    ? models.find((m) => m.id === defaultModelId && m.source === "system")
    : undefined;

  const selectedKey = defaultRow
    ? modelKey(defaultRow)
    : modelKey({ id: value.model, source: value.source, provider: value.provider });
  const selectedModel = models.find((m) => modelKey(m) === selectedKey);

  return (
    <div className={cn("flex items-center", field && "w-full")}>
      <Popover open={open && !disabled} onOpenChange={(nextOpen) => setOpen(nextOpen && !disabled)}>
        <PopoverTrigger asChild>
          <Button
            disabled={disabled}
            variant={field ? "outline" : "ghost"}
            size="sm"
            className={cn(
              "disabled:pointer-events-auto disabled:cursor-not-allowed",
              field
                ? "h-7 w-full justify-between gap-1 px-3 text-[13px] font-normal disabled:hover:bg-background disabled:hover:text-foreground"
                : "h-7 gap-1 rounded-sm px-2 text-[12px] text-muted-foreground hover:text-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
            )}
          >
            {selectedModel?.label ||
              value.model ||
              (showsDefault ? defaultModelId : "") ||
              "Select model"}
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
                  "flex h-8 w-full items-center justify-between rounded-[2px] px-2 text-left text-[13px] transition-colors hover:bg-muted",
                  isSelected && "bg-accent text-foreground",
                )}
                onClick={() => {
                  // Picking the already-shown default would look like a no-op
                  // while pinning the parent to it, opting it out of any later
                  // change to the default.
                  if (!(defaultRow && isSelected)) {
                    onChange({
                      model: m.id,
                      provider: m.provider,
                      source: m.source,
                      adapter: m.adapter,
                    });
                  }
                  setOpen(false);
                }}
              >
                <span className="flex items-center gap-1.5">
                  {isSelected && <span className="text-[12px]">&#10003;</span>}
                  {m.label}
                  {m.source === "byok" && !m.supported && (
                    <span className="text-[12px] text-muted-foreground">(unsupported)</span>
                  )}
                </span>
                {showProvider && (
                  <span className="shrink-0 text-[12px] text-muted-foreground">{m.provider}</span>
                )}
              </button>
            );
          })}
          {models.length === 0 && (
            <div className="px-2.5 py-3 text-center text-[12px] text-muted-foreground">
              No models available
              {workspaceId && (
                <>
                  {" — "}
                  <a
                    href={`/workspaces/${workspaceId}/settings/model-providers`}
                    className="font-medium underline"
                  >
                    configure one
                  </a>
                </>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
