import {
  prisma,
  SYSTEM_MODELS,
  ADAPTER_MODELS,
  ModelSource,
  PROVIDER_PRIORITY,
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

interface DefaultModelCandidate extends ResolvedDetectorModelSelection {
  adapter: string;
}

export async function resolveDefaultDetectorModelSelection(
  workspaceId: string,
): Promise<ResolvedDetectorModelSelection | { error: string }> {
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
  const systemModels: DefaultModelCandidate[] = SYSTEM_MODELS.filter(
    (provider) => !!process.env[provider.envVar],
  ).flatMap((provider) =>
    provider.models.map((model) => ({
      model: model.id,
      provider: provider.provider,
      source: ModelSource.SYSTEM,
      adapter: provider.piAIProvider,
    })),
  );
  const candidates = [...byokModels, ...systemModels];

  for (const adapter of PROVIDER_PRIORITY) {
    const match = candidates.find((candidate) => candidate.adapter === adapter);
    if (match) return { model: match.model, provider: match.provider, source: match.source };
  }

  const fallback = candidates[0];
  if (fallback) {
    return { model: fallback.model, provider: fallback.provider, source: fallback.source };
  }

  return modelSelectionError(DETECTOR_MODEL_SELECTION_REQUIRED_ERROR);
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

  const configuredModels = byokProvider.customModels.map((id) => id.trim()).filter(Boolean);
  if (!configuredModels.includes(model)) {
    return modelSelectionError("Selected BYOK model is not configured for this provider");
  }

  const catalog = ADAPTER_MODELS[byokProvider.adapter as LLMAdapter];
  if (catalog && !catalog.some((candidate) => candidate.id === model)) {
    return modelSelectionError("Selected BYOK model is not supported by Traceroot");
  }

  return { model, provider: byokProvider.provider, source: ModelSource.BYOK };
}
