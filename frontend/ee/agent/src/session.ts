import { prisma } from "@traceroot/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage, Message } from "@earendil-works/pi-ai";

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
  // Cumulative session tokens as reported by the stream; persisted in the
  // final segment's metadata (no dedicated column), not aggregated for billing.
  totalTokens?: number;
}

export class SessionManager {
  constructor(private sessionId: string) {}

  /**
   * Build conversation context for the Agent.
   * Like Mom's sessionManager.buildSessionContext() — loads persisted
   * messages from DB and converts them to AgentMessage format.
   *
   * User turns are restored verbatim. Assistant turns are restored as plain
   * text messages with synthesized LLM metadata (zero usage, "stop") — enough
   * for the model to see what it previously said, which it cannot infer.
   * tool_step rows are UI-only and skipped: replaying stale tool results is
   * worse than letting the agent re-invoke the tool when it needs the data.
   */
  async buildContext(): Promise<AgentMessage[]> {
    const session = await prisma.aISession.findUnique({
      where: { id: this.sessionId },
      include: { messages: { orderBy: { createTime: "asc" } } },
    });

    if (!session || session.messages.length === 0) {
      return [];
    }

    const zeroUsage: AssistantMessage["usage"] = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    return (
      session.messages
        // Content-less assistant rows are usage carriers for runs that ended at
        // a tool boundary — there is no text to restore, so skip them. This
        // also drops thinking-only segments (empty content, thinking in
        // metadata), which the UI renders but model context never restored.
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.content !== ""))
        .map(
          (m): Message =>
            m.role === "user"
              ? ({
                  role: "user",
                  content: [{ type: "text", text: m.content }],
                  timestamp: m.createTime.getTime(),
                } satisfies UserMessage)
              : ({
                  role: "assistant",
                  content: [{ type: "text", text: m.content }],
                  api: "restored",
                  provider: m.provider ?? "unknown",
                  model: m.model ?? "unknown",
                  usage: zeroUsage,
                  stopReason: "stop",
                  timestamp: m.createTime.getTime(),
                } satisfies AssistantMessage),
        )
    );
  }

  /**
   * Append a message to the session.
   * Like Mom's sessionManager.appendMessage() — persists to DB.
   *
   * `workspaceId` and `kind` are required on every AIMessage row (see schema).
   * We derive both from the parent AISession: `kind = "chat"` for user sessions
   * (userId set), `kind = "rca"` for system sessions (userId null). This
   * mirrors the existing convention in createSession.
   */
  async appendMessage(
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
    tokenUsage?: TokenUsageData,
  ): Promise<void> {
    const session = await prisma.aISession.findUnique({
      where: { id: this.sessionId },
      select: { workspaceId: true, userId: true },
    });
    if (!session) {
      throw new Error(`AISession not found: ${this.sessionId}`);
    }
    const kind = session.userId === null ? "rca" : "chat";

    await prisma.aIMessage.create({
      data: {
        sessionId: this.sessionId,
        workspaceId: session.workspaceId,
        kind,
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
  userId?: string; // optional — null for system/RCA sessions
  title?: string;
}) {
  return prisma.aISession.create({
    data: {
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      userId: params.userId ?? null,
      title: params.title,
    },
  });
}

/**
 * Get a session by ID.
 * For user sessions: requires userId match.
 * For system sessions (userId=null): scoped to the same projectId so a user
 * from another project cannot read RCA sessions they don't own.
 */
export async function getSession(id: string, userId: string, projectId?: string) {
  // System-session OR branch is only safe when projectId scopes the lookup.
  // Prisma omits `undefined` fields, which would turn `{ userId: null,
  // projectId: undefined }` into `{ userId: null }` — matching every system
  // session across every project. Drop the OR branch when projectId is
  // missing so unscoped callers cannot accidentally read other projects'
  // RCA sessions.
  const orBranches: Array<Record<string, unknown>> = [{ userId }];
  if (projectId) orBranches.push({ userId: null, projectId });

  return prisma.aISession.findFirst({
    where: { id, OR: orBranches },
    include: { messages: { orderBy: { createTime: "asc" } } },
  });
}

export async function getSessionMessages(sessionId: string, userId: string, projectId?: string) {
  const orBranches: Array<Record<string, unknown>> = [{ userId }];
  if (projectId) orBranches.push({ userId: null, projectId });

  const session = await prisma.aISession.findFirst({
    where: { id: sessionId, OR: orBranches },
    include: { messages: { orderBy: { createTime: "asc" } } },
  });
  if (!session) return null;
  return session.messages;
}

export async function listSessions(params: { projectId: string; userId: string; limit?: number }) {
  // Only return sessions belonging to this user — system sessions (userId=null) are excluded
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
  // Verify ownership before deleting — only the session owner can delete
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
