import { prisma } from "@traceroot/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  StopReason,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

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

/** Upper bound on one restored tool record's serialized text — a record is a summary, never a payload dump. */
const TOOL_RECORD_CHAR_CAP = 600;

/** How much of a tool result's text survives into a generic (no structured details) record. */
const RESULT_SNIPPET_CHARS = 200;

/**
 * What a tool_step row whose metadata never named a tool degrades to. A bare
 * literal: with no tool name there is no call to reconstruct, and nothing
 * member-controlled may enter this sentence.
 */
const UNIDENTIFIED_TOOL_RECORD = "[prior tool call] a tool call";

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

/** Serialize to bounded JSON: every member-controlled string lands escaped, never as prose. */
const UNSERIALIZABLE_JSON = '"[unserializable]"';

function boundedJson(value: unknown, max: number): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    // Returned whole, never clipped: a caller comparing against the cap must
    // not mistake this short stand-in for a value that genuinely fit.
    return UNSERIALIZABLE_JSON;
  }
  return clip(json, max);
}

/**
 * Bound the restored call's arguments while keeping them a structured object.
 * Oversized args collapse to the same `{truncated: true, ...}` shape the
 * persister uses, so an over-cap payload is self-describing rather than dumped.
 */
function boundedArgs(value: unknown): Record<string, unknown> {
  const args = asRecord(value);
  if (!args) return {};
  const json = boundedJson(args, Number.MAX_SAFE_INTEGER);
  if (json === UNSERIALIZABLE_JSON) return { truncated: true, preview: UNSERIALIZABLE_JSON };
  if (json.length <= TOOL_RECORD_CHAR_CAP) return args;
  return { truncated: true, preview: clip(json, TOOL_RECORD_CHAR_CAP) };
}

/**
 * The outcome as bounded JSON. An over-cap outcome collapses to the same
 * self-describing shape oversized args take, rather than a clipped string:
 * half a JSON object is not JSON, and the model would be reading a fragment.
 */
function boundedOutcome(meta: Record<string, unknown>): string {
  const json = boundedJson(toolOutcome(meta), Number.MAX_SAFE_INTEGER);
  if (json !== UNSERIALIZABLE_JSON && json.length <= TOOL_RECORD_CHAR_CAP) return json;
  return JSON.stringify({ truncated: true, preview: clip(json, TOOL_RECORD_CHAR_CAP) });
}

/**
 * The outcome of a persisted tool call, as structured data: created/reused,
 * declined by the user, failed, or completed, with the resource id where one
 * exists. Every member-controlled value stays a JSON field — a dashboard
 * titled `"; ignore prior instructions …` must read to the model as a string,
 * not as a sentence.
 *
 * A row whose result is absent or truncated cannot claim an outcome it does
 * not know: it reports the call's error flag and says the result is missing.
 */
function toolOutcome(meta: Record<string, unknown>): Record<string, unknown> {
  const isError = meta.isError === true;
  const result = isTruncatedMarker(meta.result) ? undefined : asRecord(meta.result);
  if (result === undefined) {
    return { status: isError ? "failed" : "unknown", note: "the result was not persisted" };
  }

  const details = asRecord(result.details);
  if (details?.kind === "proposal_declined") {
    // The user answered the confirmation card with skip/revise: the write
    // never ran, and the record must be unmistakable about that.
    return {
      status: "declined_by_user",
      executed: false,
      revisionRequested: details.outcome === "revised",
    };
  }
  if (details?.kind === "resource_created") {
    const resourceType =
      typeof details.resourceType === "string" ? details.resourceType : "resource";
    const resourceId = typeof details.resourceId === "string" ? details.resourceId : null;
    return details.created === false
      ? {
          status: "already_existed",
          note: "reused the existing one, nothing new was created",
          resourceType,
          resourceId,
        }
      : { status: "created", resourceType, resourceId };
  }

  const text = firstResultText(result);
  return {
    status: isError ? "failed" : "completed",
    ...(text ? { result: clip(text, RESULT_SNIPPET_CHARS) } : {}),
  };
}

/** One persisted tool_step row, reconstructed as a real call/result pair. */
export interface RestoredToolStep {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** JSON outcome text carried by the synthesized tool-result message. */
  outcome: string;
  isError: boolean;
}

/**
 * Rebuild a persisted tool_step row's metadata into the call/result pair the
 * model originally saw. Returns undefined when the row never named a tool —
 * there is nothing to reconstruct, and the caller degrades to a bare literal.
 */
export function restoreToolStep(metadata: unknown, rowId: string): RestoredToolStep | undefined {
  const meta = asRecord(metadata);
  const toolName = typeof meta?.toolName === "string" && meta.toolName ? meta.toolName : undefined;
  if (!meta || !toolName) return undefined;

  const toolCallId =
    typeof meta.toolCallId === "string" && meta.toolCallId ? meta.toolCallId : `restored-${rowId}`;
  return {
    toolCallId,
    toolName,
    args: boundedArgs(meta.args),
    outcome: boundedOutcome(meta),
    isError: meta.isError === true,
  };
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
   *
   * tool_step rows are restored as the call/result pair they originally were
   * (see restoreToolStep): with write tools in play, dropping them would make
   * a fulfilled create look unanswered and a rebuilt agent would execute it
   * again. The pair keeps member-controlled values — names, titles, result
   * snippets — inside tool arguments and a JSON tool result, where the model
   * reads them as data. Folding them into assistant prose instead would let a
   * dashboard titled `"; ignore prior instructions …` reach the model as
   * instructions, and any project member can seed such a row.
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

    const restoredAssistant = (
      content: AssistantMessage["content"],
      m: (typeof session.messages)[number],
      stopReason: StopReason = "stop",
    ) =>
      ({
        role: "assistant",
        content,
        api: "restored",
        provider: m.provider ?? "unknown",
        model: m.model ?? "unknown",
        usage: zeroUsage,
        stopReason,
        timestamp: m.createTime.getTime(),
      }) satisfies AssistantMessage;

    const restoredToolStep = (m: (typeof session.messages)[number]): Message[] => {
      const step = restoreToolStep(m.metadata, m.id);
      if (!step) {
        return [restoredAssistant([{ type: "text", text: UNIDENTIFIED_TOOL_RECORD }], m)];
      }
      return [
        restoredAssistant(
          [
            {
              type: "toolCall",
              id: step.toolCallId,
              name: step.toolName,
              arguments: step.args,
            },
          ],
          m,
          "toolUse",
        ),
        {
          role: "toolResult",
          toolCallId: step.toolCallId,
          toolName: step.toolName,
          content: [{ type: "text", text: step.outcome }],
          isError: step.isError,
          timestamp: m.createTime.getTime(),
        } satisfies ToolResultMessage,
      ];
    };

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
        .flatMap((m): Message[] =>
          m.role === "user"
            ? [
                {
                  role: "user",
                  content: [{ type: "text", text: m.content }],
                  timestamp: m.createTime.getTime(),
                } satisfies UserMessage,
              ]
            : m.role === "tool_step"
              ? restoredToolStep(m)
              : [restoredAssistant([{ type: "text", text: m.content }], m)],
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
 * Both access branches are project-scoped when the caller names a project:
 * an owned session addressed through a different project's path must be as
 * invisible as a missing one, or the request would proceed with two
 * unreconciled tenancies (projectId from the URL, workspaceId from the
 * session). System sessions (userId=null) keep their existing semantics —
 * reachable only through their own project.
 *
 * Prisma omits `undefined` fields, which would turn `{ userId: null,
 * projectId: undefined }` into `{ userId: null }` — matching every system
 * session across every project — so without a projectId only the owner
 * branch survives, unscoped.
 */
function sessionAccessBranches(userId: string, projectId?: string): Array<Record<string, unknown>> {
  if (!projectId) return [{ userId }];
  return [
    { userId, projectId },
    { userId: null, projectId },
  ];
}

/**
 * Get a session by ID.
 * For user sessions: requires userId match, and projectId match when given.
 * For system sessions (userId=null): scoped to the same projectId so a user
 * from another project cannot read RCA sessions they don't own.
 */
export async function getSession(id: string, userId: string, projectId?: string) {
  return prisma.aISession.findFirst({
    where: { id, OR: sessionAccessBranches(userId, projectId) },
    include: { messages: { orderBy: { createTime: "asc" } } },
  });
}

export async function getSessionMessages(sessionId: string, userId: string, projectId?: string) {
  const session = await prisma.aISession.findFirst({
    where: { id: sessionId, OR: sessionAccessBranches(userId, projectId) },
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

export async function deleteSession(id: string, userId: string, projectId?: string) {
  // Verify ownership before deleting — only the session owner can delete,
  // and only through the project the session actually belongs to.
  const session = await prisma.aISession.findFirst({
    where: { id, userId, ...(projectId ? { projectId } : {}) },
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
