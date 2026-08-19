import { prisma } from "@traceroot/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";

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

export interface ToolResultData {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_REPLAY_CHARS = 8000;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBlockToText(block: unknown): string {
  if (!isRecord(block)) return formatJson(block);
  if (block.type === "text" && typeof block.text === "string") {
    return block.text;
  }
  if (block.type === "image") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    return `[image: ${mimeType}]`;
  }
  return formatJson(block);
}

function summarizeToolResult(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content.map(contentBlockToText).join("\n");
    return truncateText(text || "(empty tool result)", MAX_TOOL_RESULT_CHARS);
  }
  if (typeof result === "string") {
    return truncateText(result, MAX_TOOL_RESULT_CHARS);
  }
  return truncateText(formatJson(result), MAX_TOOL_RESULT_CHARS);
}

function userMessage(content: string, timestamp: number): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp,
  };
}

function formatToolReplay(content: string, metadata: unknown): string {
  const meta = isRecord(metadata) ? metadata : {};
  const toolName = typeof meta.toolName === "string" ? meta.toolName : "unknown_tool";
  const args = "args" in meta ? meta.args : {};
  const resultSummary =
    typeof meta.resultSummary === "string" && meta.resultSummary.length > 0
      ? meta.resultSummary
      : content;
  const status = meta.isError === true ? "error" : "success";

  return truncateText(
    [
      "[Previous tool result]",
      `Tool: ${toolName}`,
      `Status: ${status}`,
      `Args: ${formatJson(args)}`,
      "Result:",
      resultSummary,
      "",
      "If referenced /workspace files are missing after resume, rerun this tool with the recorded arguments.",
    ].join("\n"),
    MAX_REPLAY_CHARS,
  );
}

export class SessionManager {
  constructor(private sessionId: string) {}

  /**
   * Build conversation context for the Agent.
   * Like Mom's sessionManager.buildSessionContext() — loads persisted
   * messages from DB and converts them to AgentMessage format.
   *
   * We restore user messages and lightweight tool-result markers. Assistant
   * messages are still not restored natively because they require full LLM
   * metadata (api, provider, model, usage, stopReason). Tool markers are
   * replayed as user-visible context so the model can recover durable file
   * paths and rerun instructions without constructing invalid tool-result
   * sequences.
   */
  async buildContext(): Promise<AgentMessage[]> {
    const session = await prisma.aISession.findUnique({
      where: { id: this.sessionId },
      include: { messages: { orderBy: { createTime: "asc" } } },
    });

    if (!session || session.messages.length === 0) {
      return [];
    }

    const context: AgentMessage[] = [];
    for (const message of session.messages) {
      if (message.role === "user") {
        context.push(userMessage(message.content, message.createTime.getTime()));
      } else if (message.role === "tool") {
        context.push(
          userMessage(
            formatToolReplay(message.content, message.metadata),
            message.createTime.getTime(),
          ),
        );
      }
    }
    return context;
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

  async appendToolResult(params: ToolResultData): Promise<void> {
    const resultSummary = summarizeToolResult(params.result);
    const args = safeJson(params.args);
    const content = [
      `Tool ${params.isError ? "failed" : "succeeded"}: ${params.toolName}`,
      `Args: ${formatJson(args)}`,
      "Result:",
      resultSummary,
    ].join("\n");

    await this.appendMessage("tool", content, {
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      args,
      resultSummary,
      isError: params.isError,
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
