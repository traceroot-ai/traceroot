import {
  prisma,
  SYSTEM_MODELS,
  ADAPTER_MODELS,
  ModelSource,
  PROVIDER_PRIORITY,
  DETECTOR_SYSTEM_DEFAULT_MODEL_IDS,
  type LLMAdapter,
} from "@traceroot/core";

export interface ResolvedDetectorModelSelection {
  model: string;
  provider: string;
  source: "system" | "byok";
}

export const DETECTOR_MODEL_SELECTION_REQUIRED_ERROR =
  "Detector model selection is required. Choose a configured system model or BYOK provider.";

function modelSelectionError(message: string): { error: string } {
  return { error: message };
}

function byokModelIsSupported(adapter: string, model: string): boolean {
  const catalog = ADAPTER_MODELS[adapter as LLMAdapter];
  return !catalog || catalog.some((candidate) => candidate.id === model);
}

function configuredByokModels(provider: { customModels: string[] }): string[] {
  return provider.customModels.map((id) => id.trim()).filter(Boolean);
}

function byokProviderHasSupportedModel(
  provider: { adapter: string; customModels: string[] } | null,
  model: string,
): boolean {
  if (!provider) return false;
  const configuredModels = configuredByokModels(provider);
  return configuredModels.includes(model) && byokModelIsSupported(provider.adapter, model);
}

interface DefaultModelCandidate extends ResolvedDetectorModelSelection {
  adapter: string;
}

function buildDetectorSystemDefaultCandidates(): DefaultModelCandidate[] {
  return DETECTOR_SYSTEM_DEFAULT_MODEL_IDS.flatMap((modelId) => {
    const provider = SYSTEM_MODELS.find((candidate) =>
      candidate.models.some((model) => model.id === modelId),
    );
    if (!provider || !process.env[provider.envVar]) return [];

    return [
      {
        model: modelId,
        provider: provider.provider,
        source: ModelSource.SYSTEM,
        adapter: provider.piAIProvider,
      },
    ];
  });
}

function pickDefaultCandidate(
  candidates: DefaultModelCandidate[],
): ResolvedDetectorModelSelection | null {
  for (const adapter of PROVIDER_PRIORITY) {
    const match = candidates.find((candidate) => candidate.adapter === adapter);
    if (match) return { model: match.model, provider: match.provider, source: match.source };
  }

  const fallback = candidates[0];
  if (fallback) {
    return { model: fallback.model, provider: fallback.provider, source: fallback.source };
  }

  return null;
}

function pickFirstCandidate(
  candidates: DefaultModelCandidate[],
): ResolvedDetectorModelSelection | null {
  const fallback = candidates[0];
  if (!fallback) return null;
  return { model: fallback.model, provider: fallback.provider, source: fallback.source };
}

export function resolveDefaultSystemDetectorModelSelection():
  | ResolvedDetectorModelSelection
  | { error: string } {
  const systemDefault = pickFirstCandidate(buildDetectorSystemDefaultCandidates());
  if (systemDefault) return systemDefault;

  return modelSelectionError(DETECTOR_MODEL_SELECTION_REQUIRED_ERROR);
}

export async function resolveDefaultDetectorModelSelection(
  workspaceId: string,
): Promise<ResolvedDetectorModelSelection | { error: string }> {
  // Omitted detector model fields come from legacy/internal creation paths. Keep
  // those defaults pinned to the same env-backed system credential scope when it
  // exists so adding a workspace BYOK provider does not silently change future
  // detector traffic, billing, or data egress for callers that did not opt in.
  const systemDefault = resolveDefaultSystemDetectorModelSelection();
  if (!("error" in systemDefault)) return systemDefault;

  const byokProviders = await prisma.modelProvider.findMany({
    where: { workspaceId, enabled: true },
    select: { provider: true, adapter: true, customModels: true },
    orderBy: [{ createTime: "asc" }, { id: "asc" }],
  });
  const byokModels: DefaultModelCandidate[] = byokProviders.flatMap((provider) =>
    provider.customModels
      .map((id) => id.trim())
      .filter(Boolean)
      .filter((id) => byokModelIsSupported(provider.adapter, id))
      .map((id) => ({
        model: id,
        provider: provider.provider,
        source: ModelSource.BYOK,
        adapter: provider.adapter,
      })),
  );
  const byokDefault = pickDefaultCandidate(byokModels);
  if (byokDefault) return byokDefault;

  return modelSelectionError(DETECTOR_MODEL_SELECTION_REQUIRED_ERROR);
}

export async function resolveLegacyDetectorModelSelection(
  workspaceId: string,
  selection: { model: string; provider: string },
): Promise<ResolvedDetectorModelSelection | { error: string }> {
  const model = selection.model.trim();
  const provider = selection.provider.trim();

  if (!model || !provider) {
    return modelSelectionError(DETECTOR_MODEL_SELECTION_REQUIRED_ERROR);
  }

  const normalizedProvider = provider.toLowerCase();
  const systemProvider = SYSTEM_MODELS.find(
    (candidate) =>
      candidate.provider.toLowerCase() === normalizedProvider ||
      candidate.piAIProvider.toLowerCase() === normalizedProvider,
  );
  const matchesSystemModel = Boolean(
    systemProvider?.models.some((candidate) => candidate.id === model),
  );

  if (systemProvider && matchesSystemModel) {
    const byokProvider = await prisma.modelProvider.findFirst({
      where: { workspaceId, provider, enabled: true },
      select: { adapter: true, customModels: true },
    });
    if (byokProviderHasSupportedModel(byokProvider, model)) {
      return modelSelectionError(
        "Legacy detector model selection is ambiguous. Re-select the detector model before saving.",
      );
    }

    if (process.env[systemProvider.envVar]) {
      return { model, provider: systemProvider.provider, source: ModelSource.SYSTEM };
    }

    return modelSelectionError("Selected system provider is not available for this workspace");
  }

  return validateDetectorModelSelection(workspaceId, {
    model,
    provider,
    source: ModelSource.BYOK,
  });
}

export async function validateDetectorModelSelection(
  workspaceId: string,
  selection: ResolvedDetectorModelSelection,
): Promise<ResolvedDetectorModelSelection | { error: string }> {
  const model = selection.model.trim();
  const provider = selection.provider.trim();

  if (selection.source === ModelSource.SYSTEM) {
    const normalizedProvider = provider.toLowerCase();
    const systemProvider = SYSTEM_MODELS.find(
      (candidate) =>
        candidate.provider.toLowerCase() === normalizedProvider ||
        candidate.piAIProvider.toLowerCase() === normalizedProvider,
    );

    if (!systemProvider || !process.env[systemProvider.envVar]) {
      return modelSelectionError("Selected system provider is not available for this workspace");
    }

    if (!systemProvider.models.some((candidate) => candidate.id === model)) {
      return modelSelectionError("Selected system model is not available for this workspace");
    }

    return { model, provider: systemProvider.provider, source: ModelSource.SYSTEM };
  }

  const byokProvider = await prisma.modelProvider.findFirst({
    where: { workspaceId, provider, enabled: true },
    select: { provider: true, adapter: true, customModels: true },
  });

  if (!byokProvider) {
    return modelSelectionError("Selected BYOK provider is not available for this workspace");
  }

  const configuredModels = configuredByokModels(byokProvider);
  if (!configuredModels.includes(model)) {
    return modelSelectionError("Selected BYOK model is not configured for this provider");
  }

  if (!byokModelIsSupported(byokProvider.adapter, model)) {
    return modelSelectionError("Selected BYOK model is not supported by Traceroot");
  }

  return { model, provider: byokProvider.provider, source: ModelSource.BYOK };
}
