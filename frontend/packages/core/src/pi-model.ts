/**
 * Shared pi-ai model construction for agent, detector sandbox eval, and other workers.
 * Dispatch is driven by {@link ADAPTER_API_PROTOCOL} and {@link ADAPTER_DEFAULT_BASE_URL}
 * (not vendor-specific branching beyond adapter → pi-ai provider mapping).
 */
import { getModel } from "@mariozechner/pi-ai";
import type { Api, Model, Provider } from "@mariozechner/pi-ai";
import {
  SYSTEM_MODELS,
  PROVIDER_PRIORITY,
  ADAPTER_TO_PI_AI,
  ADAPTER_DEFAULT_BASE_URL,
  ADAPTER_API_PROTOCOL,
  ADAPTER_MODELS,
  type LLMAdapter,
} from "./llm-providers";

/** Workspace BYOK row (decrypted key) — same shape as agent `ProviderConfig`. */
export interface ProviderModelConfig {
  adapter: string;
  key: string;
  baseUrl: string | null;
  config: Record<string, unknown> | null;
}

const systemModelLookup = new Map<string, { piAIProvider: string; apiProtocol: string }>();
for (const sys of SYSTEM_MODELS) {
  for (const m of sys.models) {
    systemModelLookup.set(m.id, {
      piAIProvider: sys.piAIProvider,
      apiProtocol: m.apiProtocol || sys.apiProtocol,
    });
  }
}

/**
 * Build a model object with the correct `api` protocol while preserving pi-ai registry
 * metadata (pricing, context window) when available.
 */
export function buildFallbackModel(
  modelId: string,
  apiProtocol: string,
  provider: string,
): Model<Api> {
  // pi-ai registry is typed to known provider IDs; BYOK maps (e.g. deepseek → openai) are all valid lookups.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryModel = getModel(provider as any, modelId as any);
  if (registryModel) {
    return { ...registryModel, api: apiProtocol as Api };
  }
  return {
    id: modelId,
    name: modelId,
    api: apiProtocol as Api,
    provider: provider as Provider,
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function getDefaultSystemModel(): {
  modelId: string;
  piAIProvider: string;
  apiProtocol: string;
} | null {
  for (const adapter of PROVIDER_PRIORITY) {
    const sys = SYSTEM_MODELS.find((s) => s.piAIProvider === adapter && process.env[s.envVar]);
    if (sys && sys.models.length > 0) {
      return {
        modelId: sys.models[0].id,
        piAIProvider: sys.piAIProvider,
        apiProtocol: sys.models[0].apiProtocol || sys.apiProtocol,
      };
    }
  }
  return null;
}

/**
 * Resolve the pi-ai {@link Model} for a request: BYOK (adapter + protocol + base URL),
 * TraceRoot system catalog model, or best-effort default — matching agent behavior.
 */
export function resolvePiModel(
  modelId: string | undefined,
  providerConfig: ProviderModelConfig | null,
): Model<Api> {
  const defaultSystemModel = !modelId ? getDefaultSystemModel() : null;
  const effectiveModelId = modelId || defaultSystemModel?.modelId || "claude-sonnet-4-5";

  if (providerConfig) {
    const piAIProvider = ADAPTER_TO_PI_AI[providerConfig.adapter];
    if (piAIProvider) {
      const modelProtocols = providerConfig.config?.modelProtocols as
        | Record<string, string>
        | undefined;
      const catalog = ADAPTER_MODELS[providerConfig.adapter as LLMAdapter];
      const catalogProtocol = catalog?.find((m) => m.id === effectiveModelId)?.apiProtocol;
      const apiProtocol =
        modelProtocols?.[effectiveModelId] ||
        catalogProtocol ||
        ADAPTER_API_PROTOCOL[providerConfig.adapter] ||
        "openai-completions";
      const model = buildFallbackModel(effectiveModelId, apiProtocol, piAIProvider);
      const baseUrl = providerConfig.baseUrl || ADAPTER_DEFAULT_BASE_URL[providerConfig.adapter];
      if (baseUrl) {
        model.baseUrl = baseUrl;
      }
      return model;
    }
  }

  const sysInfo = systemModelLookup.get(effectiveModelId);
  if (sysInfo) {
    return buildFallbackModel(effectiveModelId, sysInfo.apiProtocol, sysInfo.piAIProvider);
  }

  if (defaultSystemModel) {
    return buildFallbackModel(
      defaultSystemModel.modelId,
      defaultSystemModel.apiProtocol,
      defaultSystemModel.piAIProvider,
    );
  }
  return getModel("anthropic", "claude-sonnet-4-5");
}
