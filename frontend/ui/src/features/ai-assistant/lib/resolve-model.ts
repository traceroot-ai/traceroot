/**
 * Pure helpers for resolving the unified LLM model list and the default pick.
 * Shared by ModelSelector (interactive picker) and AgentModelLink (read-only label).
 *
 * Behavior:
 * - When the API response is undefined (loading / no workspace), callers may
 *   fall back to the compiled-in SYSTEM_MODELS so read-only labels can still
 *   render something useful. Interactive selectors should opt out so they do
 *   not auto-pick a model before the workspace's configured providers are known.
 * - When the API response is defined, BYOK models come first, then system models.
 *   No deduplication — both consumers depend on this ordering.
 * - Default-pick walks PROVIDER_PRIORITY by adapter, then falls back to models[0].
 */
import { SYSTEM_MODELS, PROVIDER_PRIORITY } from "@traceroot/core";
import type { LLMModelsResponse } from "@/lib/api";

export interface ResolvedModel {
  id: string;
  label: string;
  provider: string;
  adapter: string;
  source: "system" | "byok";
  /** Only meaningful for BYOK; system models are always supported. */
  supported?: boolean;
}

const FALLBACK_MODELS: ResolvedModel[] = SYSTEM_MODELS.flatMap((s) =>
  s.models.map((m) => ({
    id: m.id,
    label: m.label,
    provider: s.provider,
    adapter: s.piAIProvider,
    source: "system" as const,
    supported: true,
  })),
);

interface FlattenAvailableModelsOptions {
  includeFallback?: boolean;
}

export function flattenAvailableModels(
  data: LLMModelsResponse | undefined,
  { includeFallback = true }: FlattenAvailableModelsOptions = {},
): ResolvedModel[] {
  if (!data) return includeFallback ? FALLBACK_MODELS : [];
  const systemList: ResolvedModel[] = data.systemModels.flatMap((g) =>
    g.models.map((m) => ({
      id: m.id,
      label: m.label,
      provider: g.provider,
      adapter: g.adapter,
      source: "system" as const,
      supported: true,
    })),
  );
  const byokList: ResolvedModel[] = data.byokProviders.flatMap((g) =>
    g.models.map((m) => ({
      id: m.id,
      label: m.label,
      provider: g.provider,
      adapter: g.adapter,
      source: "byok" as const,
      supported: m.supported,
    })),
  );
  return [...byokList, ...systemList];
}

interface PickDefaultModelOptions {
  preferredModelId?: string;
  preferredModelIds?: readonly string[];
  preferredSource?: "system" | "byok";
}

export function pickDefaultModel(
  models: ResolvedModel[],
  { preferredModelId, preferredModelIds, preferredSource }: PickDefaultModelOptions = {},
): ResolvedModel | undefined {
  // Skip BYOK entries marked `supported: false` (model in the BYOK provider's
  // catalog but flagged unsupported by us). Auto-selecting one would put the
  // selector into an unrunnable state on first render.
  const usable = models.filter((m) => m.supported !== false);
  if (usable.length === 0) return undefined;

  const preferredIds = preferredModelIds ?? (preferredModelId ? [preferredModelId] : []);
  for (const modelId of preferredIds) {
    const preferred = usable.find(
      (m) => m.id === modelId && (preferredSource === undefined || m.source === preferredSource),
    );
    if (preferred) return preferred;
  }

  for (const adapter of PROVIDER_PRIORITY) {
    const match = usable.find((m) => m.adapter === adapter);
    if (match) return match;
  }
  return usable[0];
}
