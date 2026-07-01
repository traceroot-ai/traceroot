import {
  ADAPTER_MODELS,
  ModelSource,
  PROVIDER_PRIORITY,
  SYSTEM_MODELS,
  prisma,
} from "@traceroot/core";
import type { LLMAdapter } from "@traceroot/core";

export type WorkspaceModelSource = (typeof ModelSource)[keyof typeof ModelSource];

export type WorkspaceModelSelection = {
  source: WorkspaceModelSource | null;
  provider: string | null;
  model: string | null;
};

export type WorkspaceModelValidationResult =
  | ({ ok: true } & WorkspaceModelSelection)
  | { ok: false; status: 400 | 403; message: string };

interface WorkspaceModelValidationOptions {
  /**
   * Detector templates may omit a concrete model/provider tuple. When allowed,
   * this resolves to the first env-backed system model immediately so stored
   * detector rows remain concrete and attributable. Interactive AI calls must
   * always send a concrete tuple.
   */
  allowDefaultSystem?: boolean;
}

type NormalizedString = { ok: true; value: string | null } | { ok: false };

function normalizeString(value: unknown): NormalizedString {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function normalizeSource(
  source: unknown,
): { ok: true; value: WorkspaceModelSource | null } | { ok: false } {
  const normalized = normalizeString(source);
  if (!normalized.ok) return normalized;
  if (normalized.value === null) return { ok: true, value: null };
  if (normalized.value === ModelSource.SYSTEM || normalized.value === ModelSource.BYOK) {
    return { ok: true, value: normalized.value };
  }
  return { ok: false };
}

function normalizeCustomModels(customModels: unknown): string[] {
  if (!Array.isArray(customModels)) return [];
  return customModels.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean);
}

function findSystemProvider(provider: string) {
  return SYSTEM_MODELS.find(
    (candidate) => candidate.provider === provider || candidate.piAIProvider === provider,
  );
}

function findDefaultSystemProvider() {
  for (const provider of PROVIDER_PRIORITY) {
    const systemProvider = SYSTEM_MODELS.find(
      (candidate) =>
        candidate.piAIProvider === provider &&
        candidate.models.length > 0 &&
        process.env[candidate.envVar],
    );
    if (systemProvider) return systemProvider;
  }
  return undefined;
}

export async function validateWorkspaceModelSelection(
  workspaceId: string,
  selection: { source: unknown; provider: unknown; model: unknown },
  { allowDefaultSystem = false }: WorkspaceModelValidationOptions = {},
): Promise<WorkspaceModelValidationResult> {
  const normalizedSource = normalizeSource(selection.source);
  const normalizedProvider = normalizeString(selection.provider);
  const normalizedModel = normalizeString(selection.model);

  if (!normalizedSource.ok) {
    return { ok: false, status: 400, message: `source must be "system" or "byok"` };
  }
  if (!normalizedProvider.ok) {
    return { ok: false, status: 400, message: "provider must be a string" };
  }
  if (!normalizedModel.ok) {
    return { ok: false, status: 400, message: "model must be a string" };
  }

  const source = normalizedSource.value;
  const provider = normalizedProvider.value;
  const model = normalizedModel.value;

  const hasProviderOrModel = provider !== null || model !== null;
  if (source === null && !hasProviderOrModel) {
    return {
      ok: false,
      status: 400,
      message: "source is required for model selection",
    };
  }
  if (source === null) {
    return { ok: false, status: 400, message: "source is required for model selection" };
  }

  if (provider === null && model === null) {
    if (allowDefaultSystem && source === ModelSource.SYSTEM) {
      const defaultProvider = findDefaultSystemProvider();
      if (defaultProvider) {
        return {
          ok: true,
          source,
          provider: defaultProvider.piAIProvider,
          model: defaultProvider.models[0].id,
        };
      }
      return {
        ok: false,
        status: 400,
        message: "No system model provider is available for this workspace",
      };
    }
    return {
      ok: false,
      status: 400,
      message: "provider and model are required for model selection",
    };
  }
  if (provider === null || model === null) {
    return {
      ok: false,
      status: 400,
      message: "provider and model must both be set for model selection",
    };
  }

  if (source === ModelSource.SYSTEM) {
    const systemProvider = findSystemProvider(provider);
    if (!systemProvider || !process.env[systemProvider.envVar]) {
      return {
        ok: false,
        status: 400,
        message: "Selected system provider is not available for this workspace",
      };
    }
    if (!systemProvider.models.some((candidate) => candidate.id === model)) {
      return {
        ok: false,
        status: 400,
        message: "Selected system model is not available for this provider",
      };
    }
    return { ok: true, source, provider: systemProvider.piAIProvider, model };
  }

  const configuredProvider = await prisma.modelProvider.findFirst({
    where: { workspaceId, provider, enabled: true },
    select: { adapter: true, customModels: true },
  });
  if (!configuredProvider) {
    return {
      ok: false,
      status: 403,
      message: "Selected BYOK provider is not configured for this workspace",
    };
  }

  const configuredModels = normalizeCustomModels(configuredProvider.customModels);
  if (!configuredModels.includes(model)) {
    return {
      ok: false,
      status: 400,
      message: "Selected BYOK model is not configured for this provider",
    };
  }

  const catalog = ADAPTER_MODELS[configuredProvider.adapter as LLMAdapter];
  if (catalog && !catalog.some((candidate) => candidate.id === model)) {
    return {
      ok: false,
      status: 400,
      message: "Selected BYOK model is not supported by this provider",
    };
  }

  return { ok: true, source, provider, model };
}
