import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type AgentMessage,
} from "@mariozechner/pi-agent-core";
import { getModel, getEnvApiKey, type Message } from "@mariozechner/pi-ai";
import {
  prisma,
  decryptKey,
  SYSTEM_MODELS,
  ADAPTER_TO_PI_AI,
  ADAPTER_DEFAULT_BASE_URL,
  BEDROCK_USE_DEFAULT_CREDENTIALS,
} from "@traceroot/core";
import { SessionManager } from "./session.js";

// Provider key cache: workspaceId:provider -> { key, expiresAt }
const keyCache = new Map<string, { key: string; expiresAt: number }>();
const KEY_CACHE_TTL_MS = 60_000; // 1 minute

interface ProviderConfig {
  adapter: string;
  key: string;
  baseUrl: string | null;
  config: Record<string, unknown> | null;
}

/**
 * Resolve full provider config for a BYOK provider by name.
 */
async function fetchProviderConfig(
  workspaceId: string,
  providerName: string,
): Promise<ProviderConfig | null> {
  const cacheKey = `${workspaceId}:${providerName}`;
  const cached = keyCache.get(cacheKey);

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
      keyCache.set(cacheKey, { key, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
      return {
        adapter: row.adapter,
        key,
        baseUrl: row.baseUrl,
        config: row.config as Record<string, unknown> | null,
      };
    }
  } catch (err) {
    console.warn(`[Agent] Failed to fetch BYOK config for ${providerName}`);
  }

  return null;
}

/**
 * Resolve an API key for a pi-ai provider: BYOK (DB) first, env var fallback.
 * Used as the getApiKey callback for the Agent.
 */
async function fetchProviderKey(workspaceId: string, provider: string): Promise<string> {
  const cacheKey = `${workspaceId}:${provider}`;
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  // Try to find any BYOK provider that maps to this pi-ai provider
  try {
    const rows = await prisma.modelProvider.findMany({
      where: { workspaceId, enabled: true },
      select: { adapter: true, keyCipher: true, provider: true },
    });

    for (const row of rows) {
      const piAiProvider = ADAPTER_TO_PI_AI[row.adapter];
      if (piAiProvider === provider && row.keyCipher) {
        const key = decryptKey(row.keyCipher);
        keyCache.set(cacheKey, { key, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
        return key;
      }
    }
  } catch (err) {
    console.warn(`[Agent] Failed to fetch BYOK key for ${provider}`);
  }

  // Fall back to env var
  const envKey = getEnvApiKey(provider);
  if (!envKey) {
    throw new Error(
      `No API key found for provider "${provider}". ` +
        `Configure a BYOK key in workspace settings or set the environment variable.`,
    );
  }
  return envKey;
}

// Agent cache: one Agent per conversation session
const sessionAgents = new Map<string, Agent>();
const sessionManagers = new Map<string, SessionManager>();
const sessionModels = new Map<string, string>();

// Build system model lookup from SYSTEM_MODELS
const systemModelLookup = new Map<string, { piAiProvider: string; apiProtocol: string }>();
for (const sys of SYSTEM_MODELS) {
  for (const m of sys.models) {
    systemModelLookup.set(m.id, {
      piAiProvider: sys.piAiProvider,
      apiProtocol: sys.apiProtocol,
    });
  }
}

// Provider → default base URL for fallback model objects
const PROVIDER_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/**
 * Build a fallback model object for models not yet in pi-ai's registry.
 * Uses the same shape as pi-ai model objects.
 */
function buildFallbackModel(modelId: string, apiProtocol: string, provider: string) {
  return {
    id: modelId,
    name: modelId,
    api: apiProtocol,
    provider,
    baseUrl: PROVIDER_BASE_URLS[provider] || "",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function resolveModel(modelId?: string, providerConfig?: ProviderConfig | null) {
  const effectiveModelId = modelId || "claude-sonnet-4-5";

  // 1. BYOK: use adapter → pi-ai provider mapping
  if (providerConfig) {
    const piAiProvider = ADAPTER_TO_PI_AI[providerConfig.adapter];
    if (piAiProvider) {
      const model = getModel(piAiProvider as any, effectiveModelId as any);
      const baseUrl = providerConfig.baseUrl || ADAPTER_DEFAULT_BASE_URL[providerConfig.adapter];
      if (baseUrl && model && typeof model === "object" && "config" in model) {
        (model as any).config = {
          ...(model as any).config,
          baseURL: baseUrl,
        };
      }
      return model;
    }
  }

  // 2. System models: try pi-ai first, fallback to manual construction
  const sysInfo = systemModelLookup.get(effectiveModelId);
  if (sysInfo) {
    const model = getModel(sysInfo.piAiProvider as any, effectiveModelId as any);
    if (model) return model;
    // Model not in pi-ai registry — build a compatible object
    console.log(`[Agent] Model "${effectiveModelId}" not in pi-ai, using fallback`);
    return buildFallbackModel(effectiveModelId, sysInfo.apiProtocol, sysInfo.piAiProvider);
  }

  // 3. Default
  return getModel("anthropic", "claude-sonnet-4-5");
}

export interface AgentRunnerConfig {
  sessionId: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  model?: string;
  providerName?: string; // BYOK provider name
  source?: "system" | "byok"; // where the model comes from
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
  if (config.source === "byok" && config.providerName) {
    providerConfig = await fetchProviderConfig(config.workspaceId, config.providerName);
  }

  const model = resolveModel(config.model, providerConfig);

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      thinkingLevel: "off",
      tools: config.tools,
    },
    convertToLlm: (messages: AgentMessage[]) => messages as Message[],
    getApiKey: async (provider: string) => {
      // If we have BYOK config with a decrypted key, use it directly
      if (providerConfig && providerConfig.key !== BEDROCK_USE_DEFAULT_CREDENTIALS) {
        const expectedPiAi = ADAPTER_TO_PI_AI[providerConfig.adapter];
        if (expectedPiAi === provider) {
          return providerConfig.key;
        }
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
