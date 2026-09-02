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

/** Upper bound on one restored tool record's text — a record is a summary, never a payload dump. */
const TOOL_RECORD_CHAR_CAP = 600;

/** How much of a tool result's text survives into a generic (no structured details) record. */
const RESULT_SNIPPET_CHARS = 200;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The stream persister replaces oversized metadata values with `{truncated: true, ...}` markers. */
function isTruncatedMarker(value: unknown): boolean {
  return asRecord(value)?.truncated === true;
}

function firstResultText(result: Record<string, unknown>): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const text = asRecord(block)?.text;
    if (typeof text === "string" && text) return text;
  }
  return undefined;
}

/**
 * Render a persisted tool_step row's metadata as one compact factual line the
 * rebuilt model context carries in place of the original tool call/result
 * pair: tool name, the identifying arg (name/title), and the outcome —
 * created/reused/declined/failed — with the resource id where one exists.
 *
 * A row whose metadata is absent or truncated degrades to a bare "a <tool>
 * call completed": an honest record must never claim an outcome it cannot
 * know from what was persisted.
 */
export function describeToolStep(metadata: unknown): string {
  const meta = asRecord(metadata);
  const toolName = typeof meta?.toolName === "string" && meta.toolName ? meta.toolName : undefined;
  const degraded = `[prior tool call] ${toolName ? `a ${toolName} call` : "a tool call"} completed`;
  if (!meta || !toolName) return degraded;

  const args = isTruncatedMarker(meta.args) ? undefined : asRecord(meta.args);
  const keyArg = [args?.name, args?.title].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const call = keyArg ? `${toolName} ("${clip(keyArg, 120)}")` : toolName;

  const result = isTruncatedMarker(meta.result) ? undefined : asRecord(meta.result);
  if (result === undefined) return degraded;

  const details = asRecord(result.details);
  let outcome: string;
  if (details?.kind === "proposal_declined") {
    // The user answered the confirmation card with skip/revise: the write
    // never ran, and the record must be unmistakable about that.
    outcome =
      details.outcome === "revised"
        ? "proposal declined by the user with a revision request — not executed"
        : "proposal declined by the user — not executed";
  } else if (details?.kind === "resource_created") {
    const resourceType =
      typeof details.resourceType === "string" ? details.resourceType : "resource";
    const resourceId = typeof details.resourceId === "string" ? details.resourceId : "unknown id";
    outcome =
      details.created === false
        ? `${resourceType} ${resourceId} already existed — reused it, nothing new was created`
        : `created ${resourceType} ${resourceId}`;
  } else {
    const text = firstResultText(result);
    const verb = meta.isError === true ? "failed" : "completed";
    outcome = text ? `${verb}: ${clip(text, RESULT_SNIPPET_CHARS)}` : verb;
  }
  return clip(`[prior tool call] ${call} — ${outcome}`, TOOL_RECORD_CHAR_CAP);
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
   * tool_step rows are restored as compact factual records (see
   * describeToolStep): with write tools in play, dropping them would make a
   * fulfilled create look unanswered and a rebuilt agent would execute it
   * again — the records tell the model which writes already happened, without
   * replaying stale payloads.
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

    const restoredAssistant = (text: string, m: (typeof session.messages)[number]) =>
      ({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "restored",
        provider: m.provider ?? "unknown",
        model: m.model ?? "unknown",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: m.createTime.getTime(),
      }) satisfies AssistantMessage;

    return (
      session.messages
        // Content-less assistant rows are usage carriers for runs that ended at
        // a tool boundary — there is no text to restore, so skip them. This
        // also drops thinking-only segments (empty content, thinking in
        // metadata), which the UI renders but model context never restored.
        .filter(
          (m) =>
            m.role === "user" ||
            m.role === "tool_step" ||
            (m.role === "assistant" && m.content !== ""),
        )
        .map(
          (m): Message =>
            m.role === "user"
              ? ({
                  role: "user",
                  content: [{ type: "text", text: m.content }],
                  timestamp: m.createTime.getTime(),
                } satisfies UserMessage)
              : m.role === "tool_step"
                ? // Restored as assistant-visible history, not a reconstructed
                  // toolCall/toolResult pair: pi's restored-message shape here
                  // is plain text, and a factual record is all the model needs
                  // to know the call already happened.
                  restoredAssistant(describeToolStep(m.metadata), m)
                : restoredAssistant(m.content, m),
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
