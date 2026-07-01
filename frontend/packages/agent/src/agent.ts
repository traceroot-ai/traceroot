import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { getEnvApiKey, type Message } from "@earendil-works/pi-ai";
import { ADAPTER_TO_PI_AI, BEDROCK_USE_DEFAULT_CREDENTIALS, ModelSource } from "@traceroot/core";
import {
  resolvePiModel,
  fetchProviderConfig,
  invalidateProviderConfigCache,
  type ProviderModelConfig,
} from "@traceroot/core/model-resolver";
import { SessionManager } from "./session.js";

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
  onError: (error: Error) => void | Promise<void>;
  onDone: () => void | Promise<void>;
}

interface RunAgentOptions {
  signal?: AbortSignal;
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
  let providerConfig: ProviderModelConfig | null = null;
  if (config.source === ModelSource.BYOK) {
    if (!config.providerName) {
      throw new Error("BYOK provider is required for BYOK model selections.");
    }

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
    `[Agent] Using model="${config.model || "claude-sonnet-4-5"}" source=${config.source || ModelSource.SYSTEM} provider=${config.providerName || "—"}`,
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
      if (config.source === ModelSource.BYOK) {
        if (!providerConfig) {
          return "";
        }
        const expectedPiAi = ADAPTER_TO_PI_AI[providerConfig.adapter];
        if (expectedPiAi === provider) {
          if (providerConfig.key === BEDROCK_USE_DEFAULT_CREDENTIALS) {
            return "";
          }
          return providerConfig.key;
        }
        console.warn(
          `[Agent] BYOK provider "${config.providerName}" maps to "${expectedPiAi}", not requested provider "${provider}"`,
        );
        return "";
      }

      // System models: always use env var, never fall through to BYOK keys
      const envKey = getEnvApiKey(provider);
      if (envKey) return envKey;
      return "";
    },
  });

  const sessionManager = new SessionManager(config.sessionId);

  // Load existing conversation history
  const agentMessages = await sessionManager.buildContext();
  if (agentMessages.length > 0) {
    // pi-agent-core 0.74.0 dropped `replaceMessages` in favor of direct state
    // assignment. Semantically equivalent — sets the agent's message history.
    agent.state.messages = agentMessages;
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
  options: RunAgentOptions = {},
): Promise<void> {
  const { signal } = options;
  if (signal?.aborted) {
    return;
  }

  const abortAgent = () => agent.abort();
  signal?.addEventListener("abort", abortAgent, { once: true });

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    try {
      handler.onEvent(event);
    } catch (err) {
      console.error("[Agent] Error in event handler:", err);
    }
  });

  try {
    await agent.prompt(userMessage);
    if (!signal?.aborted) {
      await handler.onDone();
    }
  } catch (error) {
    if (!signal?.aborted) {
      await handler.onError(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    signal?.removeEventListener("abort", abortAgent);
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
  invalidateProviderConfigCache(workspaceId, providerName);
  // Evict session agents that may hold a stale key in their closure
  for (const [sessionId, modelKey] of sessionModels) {
    if (modelKey.includes(providerName)) {
      sessionAgents.delete(sessionId);
      sessionModels.delete(sessionId);
    }
  }
}
