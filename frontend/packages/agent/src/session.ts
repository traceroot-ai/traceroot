import { prisma } from "@traceroot/core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage, Message } from "@mariozechner/pi-ai";

// ============================================================
// SessionManager — follows Mom's SessionManager pattern
// Mom: context.jsonl file <-> Agent messages
// Ours: PostgreSQL AISession/AIMessage <-> Agent messages
// ============================================================

export interface TokenUsageData {
  model: string;
  provider: string;
  isByok: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export class SessionManager {
  constructor(private sessionId: string) {}

  /**
   * Build conversation context for the Agent.
   * Like Mom's sessionManager.buildSessionContext() — loads persisted
   * messages from DB and converts them to AgentMessage format.
   *
   * We only restore user messages from DB. Assistant messages are not
   * restored because they require full LLM metadata (api, provider, model,
   * usage, stopReason). The agent will see user messages as context and
   * generate fresh responses.
   */
  async buildContext(): Promise<AgentMessage[]> {
    const session = await prisma.aISession.findUnique({
      where: { id: this.sessionId },
      include: { messages: { orderBy: { createTime: "asc" } } },
    });

    if (!session || session.messages.length === 0) {
      return [];
    }

    // Only restore user messages — assistant messages lack required LLM metadata
    return session.messages
      .filter((m) => m.role === "user")
      .map(
        (m): UserMessage => ({
          role: "user",
          content: [{ type: "text", text: m.content }],
          timestamp: m.createTime.getTime(),
        }),
      );
  }

  /**
   * Append a message to the session.
   * Like Mom's sessionManager.appendMessage() — persists to DB.
   */
  async appendMessage(
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
    tokenUsage?: TokenUsageData,
  ): Promise<void> {
    await prisma.aIMessage.create({
      data: {
        sessionId: this.sessionId,
        role,
        content,
        metadata: metadata as any,
        ...(tokenUsage && {
          model: tokenUsage.model,
          provider: tokenUsage.provider,
          isByok: tokenUsage.isByok,
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          cost: tokenUsage.cost,
        }),
      },
    });
  }
}

// ============================================================
// Low-level CRUD — used by HTTP routes
// ============================================================

export async function createSession(params: {
  projectId: string;
  workspaceId: string;
  userId: string;
  title?: string;
}) {
  return prisma.aISession.create({
    data: {
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      userId: params.userId,
      title: params.title,
    },
  });
}

export async function getSession(id: string, userId: string) {
  return prisma.aISession.findFirst({
    where: { id, userId },
    include: { messages: { orderBy: { createTime: "asc" } } },
  });
}

export async function getSessionMessages(sessionId: string, userId: string) {
  const session = await prisma.aISession.findFirst({
    where: { id: sessionId, userId },
    include: { messages: { orderBy: { createTime: "asc" } } },
  });
  if (!session) return null;
  return session.messages;
}

export async function listSessions(params: { projectId: string; userId: string; limit?: number }) {
  return prisma.aISession.findMany({
    where: {
      projectId: params.projectId,
      userId: params.userId,
    },
    orderBy: { createTime: "desc" },
    take: params.limit || 50,
  });
}

export async function deleteSession(id: string, userId: string) {
  // Verify ownership before deleting
  const session = await prisma.aISession.findFirst({
    where: { id, userId },
  });
  if (!session) return null;
  return prisma.aISession.delete({ where: { id } });
}

export async function updateSessionTitle(id: string, title: string) {
  return prisma.aISession.update({
    where: { id },
    data: { title },
  });
}
