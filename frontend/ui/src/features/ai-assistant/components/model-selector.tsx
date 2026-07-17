"use client";

import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getAvailableLLMModels } from "@/lib/api";
import { flattenAvailableModels, reconcileModelSelection } from "../lib/resolve-model";

export interface ModelSelection {
  model: string;
  provider: string;
  source: "system" | "byok";
  adapter: string; // e.g. "anthropic" | "openai" - needed for SDK routing
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
}

function modelKey(m: { id?: string; model?: string; source: string; provider: string }) {
  return `${m.source}:${m.provider}:${m.id ?? m.model}`;
}

export function ModelSelector({
  value,
  onChange,
  workspaceId,
  defaultModelId,
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
  const models = flattenAvailableModels(data, isPending);

  // Reconcile the incoming selection against the catalog:
  //   1. exact match on (model, provider, source): check adapter; backfill if empty/wrong
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

    const next = reconcileModelSelection(value, models, { pickDefaultWhenEmpty: !defaultModelId });
    if (
      next.model !== value.model ||
      next.provider !== value.provider ||
      next.source !== value.source ||
      next.adapter !== value.adapter
    ) {
      onChange(next);
    }
  }, [models, value, onChange, isPending, defaultModelId]);

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
            // Show provider tag for BYOK models to distinguish from system ones.
            const showProvider = m.source === "byok";
            return (
              <button
                key={key}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-muted/50",
                  isSelected && "font-medium text-foreground",
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
