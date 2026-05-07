/**
 * Glue between our workspace state (BYOK rows, adapter constants) and pi-ai's
 * `Model<Api>` type. Used by both the agent (RCA) and the detector sandbox eval.
 *
 * Two responsibilities here:
 *   1. Resolve a pi-ai `Model<Api>` for a request — `resolvePiModel`,
 *      `buildFallbackModel`, `getDefaultSystemModel`. We do NOT define our own
 *      model abstraction; we construct pi-ai's type with the right `api`
 *      protocol, `baseUrl`, etc., based on `ADAPTER_API_PROTOCOL` /
 *      `ADAPTER_DEFAULT_BASE_URL` + per-model and BYOK `modelProtocols` overrides.
 *   2. Look up workspace BYOK config from Postgres — `fetchProviderConfig`,
 *      `findByokKeyForPiProvider`, `invalidateProviderConfigCache`. The two halves
 *      live together because resolvePiModel takes the BYOK config that
 *      fetchProviderConfig produces; splitting them would just create churn.
 */
import { getModel } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { prisma } from "./lib/prisma.js";
import { decryptKey } from "./lib/encryption.js";
import {
  SYSTEM_MODELS,
  PROVIDER_PRIORITY,
  ADAPTER_TO_PI_AI,
  ADAPTER_DEFAULT_BASE_URL,
  ADAPTER_API_PROTOCOL,
  ADAPTER_MODELS,
} from "./llm-providers.js";

/** Workspace BYOK row (decrypted key). Same shape as agent's private ProviderConfig. */
export interface ProviderModelConfig {
  adapter: string;
  key: string;
  baseUrl: string | null;
  config: Record<string, unknown> | null;
}

// Build system model lookup from SYSTEM_MODELS.
// Per-model apiProtocol overrides the provider-level default
// (e.g. gpt-5.3-codex → openai-responses).
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
 * Build a pi-ai Model object with the correct `api` protocol while preserving
 * pi-ai registry data (pricing, context window) when available.
 * Falls back to a manual object for models not in the registry.
 */
function buildFallbackModel(modelId: string, apiProtocol: string, provider: string): Model<Api> {
  // pi-ai's getModel is typed to known provider IDs; BYOK adapter→provider maps
  // (e.g. deepseek → openai) are valid lookups.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryModel = getModel(provider as any, modelId as any);
  if (registryModel) {
    return { ...registryModel, api: apiProtocol } as Model<Api>;
  }
  return {
    id: modelId,
    name: modelId,
    api: apiProtocol,
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  } as Model<Api>;
}

/** Pick the first available system model by provider priority (env-var present). */
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
 * Build a pi-ai Model from a model id + optional BYOK provider config.
 *
 * Resolution order:
 *  1. BYOK: build from adapter config (don't trust pi-ai registry — it may
 *     assign a wrong API protocol for custom/BYOK models).
 *  2. System: use system model lookup with per-model protocol override.
 *  3. Unknown model: fall back to best available system model.
 */
export function resolvePiModel(
  modelId: string | undefined,
  providerConfig: ProviderModelConfig | null,
): Model<Api> {
  const defaultSystemModel = !modelId ? getDefaultSystemModel() : null;
  const effectiveModelId = modelId || defaultSystemModel?.modelId || "claude-sonnet-4-5";

  // 1. BYOK
  if (providerConfig) {
    const piAIProvider = ADAPTER_TO_PI_AI[providerConfig.adapter];
    if (piAIProvider) {
      const modelProtocols = (providerConfig.config as Record<string, unknown>)?.modelProtocols as
        | Record<string, string>
        | undefined;

      // BYOK with no model id: use the adapter's first curated model so we
      // don't accidentally fall back to an Anthropic default for an OpenAI-
      // compatible BYOK row. For free-text adapters (azure, amazon-bedrock,
      // openrouter) the catalog is empty — caller MUST provide modelId, else
      // we'd silently send a wrong model name to that provider.
      const catalog = ADAPTER_MODELS[providerConfig.adapter as keyof typeof ADAPTER_MODELS];
      const fallbackModelId = modelId || catalog?.[0]?.id;
      if (!fallbackModelId) {
        throw new Error(
          `BYOK adapter "${providerConfig.adapter}" has no curated model catalog ` +
            `— detectionModel must be set explicitly`,
        );
      }

      // Per-model `apiProtocol` overrides — checked in order:
      //   1. BYOK row's `config.modelProtocols` (user-overridable per workspace)
      //   2. Catalog's per-model `apiProtocol` (e.g. gpt-5.3-codex → openai-responses)
      //   3. Adapter-level default
      const catalogProtocol = catalog?.find((m) => m.id === fallbackModelId)?.apiProtocol;
      const apiProtocol =
        modelProtocols?.[fallbackModelId] ||
        catalogProtocol ||
        ADAPTER_API_PROTOCOL[providerConfig.adapter] ||
        "openai-completions";
      const model = buildFallbackModel(fallbackModelId, apiProtocol, piAIProvider);
      const baseUrl = providerConfig.baseUrl || ADAPTER_DEFAULT_BASE_URL[providerConfig.adapter];
      if (baseUrl) {
        (model as { baseUrl: string }).baseUrl = baseUrl;
      }
      return model;
    }
  }

  // 2. System model with per-model protocol
  const sysInfo = systemModelLookup.get(effectiveModelId);
  if (sysInfo) {
    return buildFallbackModel(effectiveModelId, sysInfo.apiProtocol, sysInfo.piAIProvider);
  }

  // 3. Unknown — fall back
  if (defaultSystemModel) {
    return buildFallbackModel(
      defaultSystemModel.modelId,
      defaultSystemModel.apiProtocol,
      defaultSystemModel.piAIProvider,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getModel("anthropic" as any, "claude-sonnet-4-5" as any) as Model<Api>;
}

const configCache = new Map<string, { config: ProviderModelConfig; expiresAt: number }>();
const CONFIG_CACHE_TTL_MS = 60_000;

/**
 * Resolve full BYOK provider config (decrypted key + adapter + baseUrl + config).
 * Cached for 60s. Returns null when row missing, disabled, or DB error.
 */
export async function fetchProviderConfig(
  workspaceId: string,
  providerName: string,
): Promise<ProviderModelConfig | null> {
  const cacheKey = `${workspaceId}:${providerName}`;
  const cached = configCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  try {
    const row = await prisma.modelProvider.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: providerName } },
      select: {
        adapter: true,
        keyCipher: true,
        enabled: true,
        baseUrl: true,
        config: true,
      },
    });

    if (row?.enabled && row.keyCipher) {
      const key = decryptKey(row.keyCipher);
      const providerConfig: ProviderModelConfig = {
        adapter: row.adapter,
        key,
        baseUrl: row.baseUrl,
        config: row.config as Record<string, unknown> | null,
      };
      configCache.set(cacheKey, {
        config: providerConfig,
        expiresAt: Date.now() + CONFIG_CACHE_TTL_MS,
      });
      return providerConfig;
    }
  } catch (err) {
    console.error(`[model-resolver] Failed to fetch BYOK config for ${providerName}:`, err);
  }

  return null;
}

/** Invalidate cached BYOK config (call from provider create/update/delete handlers). */
export function invalidateProviderConfigCache(workspaceId: string, providerName: string): void {
  configCache.delete(`${workspaceId}:${providerName}`);
}

/**
 * Find any enabled BYOK key in the workspace whose adapter maps to `piProvider`.
 * First match wins (BYOK rows are workspace-unique by `provider` label, but may
 * share an adapter — order is determined by Prisma's default sort).
 *
 * Returns null if no row matches, the row has no encrypted key, or the DB read fails.
 */
export async function findByokKeyForPiProvider(
  workspaceId: string,
  piProvider: string,
): Promise<string | null> {
  try {
    const rows = await prisma.modelProvider.findMany({
      where: { workspaceId, enabled: true },
      select: { provider: true, adapter: true },
    });
    for (const row of rows) {
      if (ADAPTER_TO_PI_AI[row.adapter] === piProvider) {
        const cfg = await fetchProviderConfig(workspaceId, row.provider);
        if (cfg) return cfg.key;
      }
    }
  } catch (err) {
    console.warn(`[model-resolver] BYOK key scan failed for piProvider="${piProvider}":`, err);
  }
  return null;
}
