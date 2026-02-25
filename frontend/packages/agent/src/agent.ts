import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type AgentMessage,
} from "@mariozechner/pi-agent-core";
import { getModel, getEnvApiKey, type Message } from "@mariozechner/pi-ai";
import { SessionManager } from "./session.js";

// Agent cache: one Agent per conversation session (like Mom's channelRunners map)
const sessionAgents = new Map<string, Agent>();
// SessionManager cache: one per session, paired with the Agent
const sessionManagers = new Map<string, SessionManager>();
// Track which model each cached agent was created with
const sessionModels = new Map<string, string>();

function resolveModel(modelId?: string) {
  switch (modelId) {
    case "gpt-4.1":
      return getModel("openai", "gpt-4.1");
    case "gpt-4.1-mini":
      return getModel("openai", "gpt-4.1-mini");
    case "claude-haiku-4-5":
      return getModel("anthropic", "claude-haiku-4-5");
    case "claude-sonnet-4-5":
    default:
      return getModel("anthropic", "claude-sonnet-4-5");
  }
}

export interface AgentRunnerConfig {
  sessionId: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  model?: string;
}

export interface AgentEventHandler {
  onEvent: (event: AgentEvent) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

/**
 * Get or create an Agent + SessionManager for a conversation session.
 * Follows Mom's getOrCreateRunner() pattern — one agent per session, cached.
 * SessionManager handles all Agent <-> DB sync (like Mom's SessionManager).
 */
export async function getOrCreateAgent(config: AgentRunnerConfig): Promise<{
  agent: Agent;
  sessionManager: SessionManager;
}> {
  const requestedModel = config.model || "claude-sonnet-4-5";
  const cachedModel = sessionModels.get(config.sessionId);
  const existingAgent = sessionAgents.get(config.sessionId);
  const existingManager = sessionManagers.get(config.sessionId);

  // Return cached agent if model hasn't changed
  if (existingAgent && existingManager && cachedModel === requestedModel) {
    return { agent: existingAgent, sessionManager: existingManager };
  }

  // Model changed mid-session — discard old agent (SessionManager stays, history is in DB)
  if (existingAgent) {
    sessionAgents.delete(config.sessionId);
  }

  const model = resolveModel(config.model);

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      thinkingLevel: "off",
      tools: config.tools,
    },
    // For MVP, we only use standard LLM message types (user, assistant, tool),
    // so identity conversion works. If we add custom AgentMessage types later
    // (like Mom does for Slack), this needs a real implementation.
    convertToLlm: (messages: AgentMessage[]) => messages as Message[],
    // pi-ai's getEnvApiKey() handles all provider-specific env vars automatically:
    // anthropic -> ANTHROPIC_API_KEY, openai -> OPENAI_API_KEY, etc.
    getApiKey: async (provider: string) => getEnvApiKey(provider),
  });

  // SessionManager owns the Agent <-> DB sync (like Mom's SessionManager)
  const sessionManager = new SessionManager(config.sessionId);

  // Load existing conversation history from DB into agent context
  const agentMessages = await sessionManager.buildContext();
  if (agentMessages.length > 0) {
    agent.replaceMessages(agentMessages);
  }

  sessionAgents.set(config.sessionId, agent);
  sessionModels.set(config.sessionId, requestedModel);
  if (!existingManager) {
    sessionManagers.set(config.sessionId, sessionManager);
  }
  return { agent, sessionManager: existingManager || sessionManager };
}

/**
 * Run a user message through the agent with event streaming.
 * Follows Mom's pattern: subscribe to events, then prompt.
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
