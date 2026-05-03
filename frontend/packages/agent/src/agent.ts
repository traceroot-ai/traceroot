import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type AgentMessage,
} from "@mariozechner/pi-agent-core";
import { getEnvApiKey, type Message } from "@mariozechner/pi-ai";
import {
  prisma,
  decryptKey,
  ADAPTER_TO_PI_AI,
  BEDROCK_USE_DEFAULT_CREDENTIALS,
  ModelSource,
} from "@traceroot/core";
import { resolvePiModel } from "@traceroot/core/pi-model";
import { SessionManager } from "./session.js";

interface ProviderConfig {
  adapter: string;
  key: string;
  baseUrl: string | null;
  config: Record<string, unknown> | null;
}

// Provider config cache: workspaceId:provider -> { config, expiresAt }
const configCache = new Map<string, { config: ProviderConfig; expiresAt: number }>();
const CONFIG_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Resolve full provider config for a BYOK provider by name.
 */
async function fetchProviderConfig(
  workspaceId: string,
  providerName: string,
): Promise<ProviderConfig | null> {
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
      const providerConfig: ProviderConfig = {
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
    console.error(`[Agent] Failed to fetch BYOK config for ${providerName}:`, err);
  }

  return null;
}

/**
 * Resolve an API key for a pi-ai provider: BYOK (DB) first, env var fallback.
 * Used as the getApiKey callback for the Agent.
 */
async function fetchProviderKey(workspaceId: string, provider: string): Promise<string> {
  // Check configCache — any cached provider whose adapter maps to this pi-ai provider
  for (const [, cached] of configCache) {
    if (cached.expiresAt > Date.now()) {
      const piAIProvider = ADAPTER_TO_PI_AI[cached.config.adapter];
      if (piAIProvider === provider) {
        return cached.config.key;
      }
    }
  }

  // Try to find any BYOK provider that maps to this pi-ai provider
  try {
    const rows = await prisma.modelProvider.findMany({
      where: { workspaceId, enabled: true },
      select: { adapter: true, keyCipher: true, provider: true, baseUrl: true, config: true },
    });

    for (const row of rows) {
      const piAIProvider = ADAPTER_TO_PI_AI[row.adapter];
      if (piAIProvider === provider && row.keyCipher) {
        const key = decryptKey(row.keyCipher);
        const providerConfig: ProviderConfig = {
          adapter: row.adapter,
          key,
          baseUrl: row.baseUrl,
          config: row.config as Record<string, unknown> | null,
        };
        const cacheKey = `${workspaceId}:${row.provider}`;
        configCache.set(cacheKey, {
          config: providerConfig,
          expiresAt: Date.now() + CONFIG_CACHE_TTL_MS,
        });
        return key;
      }
    }
  } catch (err) {
    console.warn(`[Agent] Failed to fetch BYOK key for ${provider}`);
  }

  // Fall back to env var
  const envKey = getEnvApiKey(provider);
  if (!envKey) {
    console.warn(`[Agent] No API key found for provider "${provider}" (no BYOK, no env var)`);
    return "";
  }
  return envKey;
}

// Agent cache: one Agent per conversation session
const sessionAgents = new Map<string, Agent>();
const sessionManagers = new Map<string, SessionManager>();
const sessionModels = new Map<string, string>();

export interface AgentRunnerConfig {
  sessionId: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  model?: string;
  providerName?: string; // BYOK provider name
  source?: ModelSource; // where the model comes from
}

export interface AgentEventHandler {
  onEvent: (event: AgentEvent) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

/**
 * Get or create an Agent + SessionManager for a conversation session.
 */
export async function getOrCreateAgent(config: AgentRunnerConfig): Promise<{
  agent: Agent;
  sessionManager: SessionManager;
}> {
  const requestedModel = config.model || "claude-sonnet-4-5";
  const cacheKeyModel = `${requestedModel}:${config.providerName || ""}:${config.source || ""}`;
  const cachedModel = sessionModels.get(config.sessionId);
  const existingAgent = sessionAgents.get(config.sessionId);
  const existingManager = sessionManagers.get(config.sessionId);

  // Return cached agent if model hasn't changed
  if (existingAgent && existingManager && cachedModel === cacheKeyModel) {
    return { agent: existingAgent, sessionManager: existingManager };
  }

  // Model changed mid-session — discard old agent
  if (existingAgent) {
    sessionAgents.delete(config.sessionId);
  }

  // Fetch BYOK provider config if this is a BYOK model
  let providerConfig: ProviderConfig | null = null;
  if (config.source === ModelSource.BYOK && config.providerName) {
    providerConfig = await fetchProviderConfig(config.workspaceId, config.providerName);
    if (!providerConfig) {
      throw new Error(
        `BYOK provider "${config.providerName}" not found or disabled. ` +
          `Check workspace settings.`,
      );
    }
  }

  const model = resolvePiModel(config.model, providerConfig);
  console.log(
    `[Agent] Using model="${config.model || "claude-sonnet-4-5"}" source=${config.source || ModelSource.SYSTEM} provider=${config.providerName || "—"} api=${model.api}`,
    JSON.stringify(model),
  );

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      thinkingLevel: "off",
      tools: config.tools,
    },
    // TODO: implement proper convertToLlm instead of identity cast
    convertToLlm: (messages: AgentMessage[]) => messages as Message[],
    getApiKey: async (provider: string) => {
      // If we have BYOK config with a decrypted key, use it directly
      if (providerConfig && providerConfig.key !== BEDROCK_USE_DEFAULT_CREDENTIALS) {
        const expectedPiAi = ADAPTER_TO_PI_AI[providerConfig.adapter];
        if (expectedPiAi === provider) {
          return providerConfig.key;
        }
      }
      // System models: always use env var, never fall through to BYOK keys
      if (config.source !== ModelSource.BYOK) {
        const envKey = getEnvApiKey(provider);
        if (envKey) return envKey;
      }
      return fetchProviderKey(config.workspaceId, provider);
    },
  });

  const sessionManager = new SessionManager(config.sessionId);

  // Load existing conversation history
  const agentMessages = await sessionManager.buildContext();
  if (agentMessages.length > 0) {
    agent.replaceMessages(agentMessages);
  }

  sessionAgents.set(config.sessionId, agent);
  sessionModels.set(config.sessionId, cacheKeyModel);
  if (!existingManager) {
    sessionManagers.set(config.sessionId, sessionManager);
  }
  return { agent, sessionManager: existingManager || sessionManager };
}

/**
 * Run a user message through the agent with event streaming.
 */
export async function runAgent(
  agent: Agent,
  userMessage: string,
  handler: AgentEventHandler,
): Promise<void> {
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    try {
      handler.onEvent(event);
    } catch (err) {
      console.error("[Agent] Error in event handler:", err);
    }
  });

  try {
    await agent.prompt(userMessage);
    handler.onDone();
  } catch (error) {
    handler.onError(error instanceof Error ? error : new Error(String(error)));
  } finally {
    unsubscribe();
  }
}

/**
 * Remove a cached agent + session manager (on session delete).
 */
export function removeAgent(sessionId: string): void {
  sessionAgents.delete(sessionId);
  sessionManagers.delete(sessionId);
  sessionModels.delete(sessionId);
}

/**
 * Invalidate cached provider config when a provider is updated or deleted.
 * Also evicts any session agents that used this provider so they re-fetch on next message.
 */
export function invalidateProviderCache(workspaceId: string, providerName: string): void {
  const cacheKey = `${workspaceId}:${providerName}`;
  configCache.delete(cacheKey);
  // Evict session agents that may hold a stale key in their closure
  for (const [sessionId, modelKey] of sessionModels) {
    if (modelKey.includes(providerName)) {
      sessionAgents.delete(sessionId);
      sessionModels.delete(sessionId);
    }
  }
}
