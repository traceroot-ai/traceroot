import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { prisma, syncStandardPrices, ModelSource } from "@traceroot/core";
import {
  createSession,
  getSession,
  getSessionMessages,
  listSessions,
  deleteSession,
  updateSessionTitle,
  executionBelongsToProject,
  type TurnAttribution,
} from "./session.js";
import { getOrCreateAgent, runAgent, removeAgent, invalidateProviderCache } from "./agent.js";
import { StreamPersister } from "./stream-persister.js";
import { UsageAccumulator } from "./usage-accumulator.js";
import {
  withAgentTrace,
  currentCaptureState,
  currentToolSpanIds,
  isAgentTraceEnabled,
  turnTraceId,
  rcaSpanName,
  type AgentTraceMeta,
  type AgentTraceKind,
} from "./self-trace.js";
import { getSystemPrompt } from "./prompts/system.js";
import { createExecutor } from "./executors/index.js";
import { createTools } from "./tools/index.js";
import type { Executor } from "./executors/interface.js";

const app = new Hono();

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";
const PORT = parseInt(new URL(AGENT_SERVICE_URL).port || "8100", 10);

// Per-session executor cache (executor lifecycle tied to session)
const sessionExecutors = new Map<string, Executor>();

/** The self-trace kind of a turn is its attribution's turn kind (the three this route produces). */
const TRACE_KIND: Record<"rca_execution" | "rca_followup" | "chat", AgentTraceKind> = {
  rca_execution: "rca",
  rca_followup: "followup",
  chat: "chat",
};

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "traceroot-agent" });
});

// Cache invalidation — called by Next.js API when a model provider is updated/deleted
app.post("/api/v1/cache/invalidate-provider", async (c) => {
  const { workspaceId, providerName } = await c.req.json<{
    workspaceId: string;
    providerName: string;
  }>();
  if (!workspaceId || !providerName) {
    return c.json({ error: "workspaceId and providerName required" }, 400);
  }
  invalidateProviderCache(workspaceId, providerName);
  console.log(
    `[Agent] Cache invalidated for provider "${providerName}" in workspace ${workspaceId}`,
  );
  return c.json({ ok: true });
});

// Session CRUD routes
app.post("/api/v1/projects/:projectId/sessions", async (c) => {
  const projectId = c.req.param("projectId");
  const userId = c.req.header("x-user-id") || undefined;
  const workspaceId = c.req.header("x-workspace-id") || "";
  const body = await c.req.json<{ title?: string; executionId?: unknown }>();

  // Every message in this session inherits the session's executionId as its
  // attribution, so an id from another project would attribute this project's
  // turns to that one. The caller is trusted to reach the route, not to name
  // an execution: confirm it exists under this project before storing it. A
  // malformed id is rejected here rather than surfacing later as an FK error
  // on the session's first message — and rather than being dropped: a caller
  // that sends an execution id of the wrong shape (a number, "") has a bug,
  // and silently creating an unattributed session would hide it.
  const { executionId } = body;
  if (executionId !== undefined && (typeof executionId !== "string" || executionId.trim() === "")) {
    return c.json({ error: "executionId must be a non-empty string" }, 400);
  }
  if (executionId && !(await executionBelongsToProject(prisma, executionId, projectId))) {
    return c.json({ error: "executionId does not belong to this project" }, 400);
  }

  const session = await createSession({
    projectId,
    workspaceId,
    userId, // undefined → stored as null for system/RCA sessions
    title: body.title,
    executionId,
  });
  return c.json(session, 201);
});

app.get("/api/v1/projects/:projectId/sessions", async (c) => {
  const projectId = c.req.param("projectId");
  const userId = c.req.header("x-user-id") || "";
  if (!userId) {
    return c.json({ error: "x-user-id header required" }, 400);
  }
  const sessions = await listSessions({ projectId, userId });
  return c.json({ sessions });
});

app.get("/api/v1/projects/:projectId/sessions/:sessionId", async (c) => {
  const userId = c.req.header("x-user-id") || "";
  const projectId = c.req.param("projectId");
  const session = await getSession(c.req.param("sessionId"), userId, projectId);
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json(session);
});

// GET messages for a session (for loading history in UI)
app.get("/api/v1/projects/:projectId/sessions/:sessionId/messages", async (c) => {
  const userId = c.req.header("x-user-id") || "";
  const projectId = c.req.param("projectId");
  const messages = await getSessionMessages(c.req.param("sessionId"), userId, projectId);
  if (!messages) return c.json({ error: "not found" }, 404);
  return c.json({ messages });
});

app.delete("/api/v1/projects/:projectId/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const userId = c.req.header("x-user-id") || "";

  // Destroy executor if one exists for this session
  const executor = sessionExecutors.get(sessionId);
  if (executor) {
    await executor.destroy();
    sessionExecutors.delete(sessionId);
  }

  removeAgent(sessionId);
  const result = await deleteSession(sessionId, userId);
  if (!result) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// Message route — SSE streaming via agent runner
app.post("/api/v1/projects/:projectId/sessions/:sessionId/messages", async (c) => {
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  const userId = c.req.header("x-user-id") || "";
  const workspaceId = c.req.header("x-workspace-id") || "";
  const body = await c.req.json<{
    message: string;
    model?: string;
    traceId?: string;
    traceSessionId?: string;
    providerName?: string;
    source?: ModelSource;
    agentTrace?: { traceId: string; kind: "rca"; metadata: Record<string, unknown> };
  }>();

  // Authorize first: caller must own the session (user-bound) or have
  // projectId scope on a system session. Without this check, any caller
  // who can reach the proxy could append messages and run the LLM in
  // another user's session by guessing/known sessionIds.
  const ownedSession = await getSession(sessionId, userId, projectId);
  if (!ownedSession) {
    return c.json({ error: "session not found" }, 404);
  }

  const systemPrompt = getSystemPrompt({
    projectId,
    traceId: body.traceId,
    traceSessionId: body.traceSessionId,
  });

  // Get or create executor for this session (lazy — not initialized until tool use)
  let executor = sessionExecutors.get(sessionId);
  if (!executor) {
    executor = createExecutor();
    sessionExecutors.set(sessionId, executor);
  }

  // Use the session's workspaceId (authorized by getSession above) rather than
  // the raw header value, so tools can't be coerced into another workspace.
  const tools = createTools({
    projectId,
    userId,
    workspaceId: ownedSession.workspaceId,
    executor,
  });

  console.log(
    `[Agent] POST message: session=${sessionId}, model=${body.model}, provider=${body.providerName}, source=${body.source}`,
  );

  const { agent, sessionManager } = await getOrCreateAgent({
    sessionId,
    projectId,
    workspaceId: ownedSession.workspaceId,
    userId,
    systemPrompt,
    tools,
    model: body.model,
    providerName: body.providerName,
    source: body.source,
  });

  console.log(`[Agent] Agent ready, running prompt: "${body.message.slice(0, 50)}"`);

  // Attribution is computed once per turn and applied to every row it
  // produces (the user message, and every assistant/tool_step row the
  // persister writes below) so a turn reads as one attributed unit.
  const attribution = (
    ownedSession.userId === null
      ? userId
        ? {
            turnKind: "rca_followup" as const,
            executionId: ownedSession.executionId,
            initiatorUserId: userId,
          }
        : {
            turnKind: "rca_execution" as const,
            executionId: ownedSession.executionId,
            initiatorUserId: null,
          }
      : { turnKind: "chat" as const, initiatorUserId: userId || null }
  ) satisfies TurnAttribution;

  // Persist user message to DB via SessionManager. The created row's id is
  // this turn's messageId, used below to derive a deterministic trace id for
  // follow-up and chat turns.
  const userRow = await sessionManager.appendMessage("user", body.message, attribution);

  // Auto-generate session title from first user message (we already have
  // the session loaded above for the auth check — reuse it).
  if (!ownedSession.title) {
    const title = body.message.slice(0, 80) + (body.message.length > 80 ? "..." : "");
    await updateSessionTitle(sessionId, title);
  }

  // The trace kind is the attribution's turn kind under another name — one
  // source of truth for what this turn is. The worker's agentTrace (forced
  // trace id + finding metadata) is only honoured on an execution turn.
  const kind = TRACE_KIND[attribution.turnKind];
  const rcaTrace = kind === "rca" ? body.agentTrace : undefined;

  // A follow-up on a system (RCA) session is a child of the execution that
  // opened the session — carry its trace/finding ids into the follow-up's own
  // trace metadata so the two are linkable in the UI. A tracing-only read: it
  // is skipped when the follow-up will not be traced and can never fail the
  // turn.
  let parent: { traceId: string; findingId: string } | null = null;
  if (kind === "followup" && ownedSession.executionId && isAgentTraceEnabled(kind)) {
    try {
      parent = await prisma.detectorRcaExecution.findUnique({
        where: { id: ownedSession.executionId },
        select: { traceId: true, findingId: true },
      });
    } catch (err) {
      console.error(`[AgentTrace] parent execution lookup failed for session ${sessionId}:`, err);
    }
  }

  const traceMeta: AgentTraceMeta = {
    traceId: rcaTrace?.traceId ?? turnTraceId(sessionId, userRow.id),
    projectId,
    kind,
    name: kind === "rca" ? rcaSpanName(rcaTrace?.metadata.detectors as string[] | undefined) : kind,
    input: body.message,
    metadata: {
      ...rcaTrace?.metadata,
      session_id: sessionId,
      ...(ownedSession.executionId ? { execution_id: ownedSession.executionId } : {}),
      ...(parent ? { finding_id: parent.findingId, parent_trace_id: parent.traceId } : {}),
    },
  };

  return streamSSE(c, async (stream) => {
    // Accumulates token usage across all message_end events (tool-use loops)
    const usageAccumulator = new UsageAccumulator();
    let loggedFirstUpdate = false;

    // Runs the agent and resolves with the persister that mirrored the run
    // into AIMessage rows (text segments, tool steps) so reloaded history
    // matches what the live stream rendered. The persister is built inside
    // the run because withAgentTrace's scope is only live in here: it charges
    // the run's capture budget (so rows and spans stop capturing together)
    // and stamps each tool_step row with the OTel span id the instrumentation
    // reported for that tool call. Outside a traced run both are undefined
    // and the persister keeps a budget of its own.
    const run = () =>
      new Promise<{ persister: StreamPersister }>((resolve) => {
        const persister = new StreamPersister(
          (role, content, metadata, tokenUsage) =>
            sessionManager.appendMessage(role, content, attribution, metadata, tokenUsage),
          { state: currentCaptureState(), toolSpanIds: currentToolSpanIds },
        );
        runAgent(agent, body.message, {
          onEvent: (event) => {
            if (event.type === "message_update") {
              // Log only the very first message_update for debugging
              if (!loggedFirstUpdate) {
                loggedFirstUpdate = true;
                console.log(`[Agent] First message_update:`, JSON.stringify(event).slice(0, 500));
              }
            } else if (event.type !== "message_start") {
              // Skip noisy message_start, log other event types
              console.log(`[Agent] Event: ${event.type}`);
            }
            // Log error details from message_end
            if (event.type === "message_end") {
              const msg = (event as any).message;
              console.log(
                `[Agent] message_end:`,
                JSON.stringify({
                  model: msg?.model,
                  provider: msg?.provider,
                  usage: msg?.usage,
                  stopReason: msg?.stopReason,
                }).slice(0, 500),
              );
              if (msg?.stopReason === "error") {
                console.error(`[Agent] API error:`, msg.errorMessage || "unknown");
              }
            }
            // Forward all events to the frontend
            stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            });

            // Mirror the event into token totals and durable rows
            usageAccumulator.onEvent(event);
            persister.onEvent(event);
          },
          onError: (error) => {
            console.error(`[Agent] ERROR:`, error.message);
            stream.writeSSE({
              event: "error",
              data: JSON.stringify({ message: error.message }),
            });
            resolve({ persister });
          },
          onDone: () => {
            resolve({ persister });
          },
        });
      });

    const outcome = await withAgentTrace(traceMeta, run, {
      recordOutput: ({ persister }) => persister.finalText() || undefined,
    });
    const { persister } = outcome.value;

    // Flush the trailing text segment (or the usage-only row) — stamped with
    // this turn's trace outcome — and wait for all rows to land. Runs once
    // here (after the run — success or error — resolves) rather than inside
    // onDone/onError, so it happens exactly once regardless of outcome.
    const tokenUsage = await usageAccumulator.toTokenUsage(body.source === ModelSource.BYOK);
    // When tracing is disabled, pass no trace argument at all: finish()'s
    // `!trace` gate must see undefined, not a present-but-inert object, or a
    // tool-only turn with the flag off would gain an extra empty assistant
    // row that main today never writes (Global Constraint: byte-identical
    // row set with the flag off).
    await persister.finish(
      tokenUsage,
      outcome.trace === "disabled"
        ? undefined
        : { traceId: traceMeta.traceId, status: outcome.trace },
    );
    console.log(`[Agent] Done. Run persisted for session ${sessionId}`);

    await stream.writeSSE({
      event: "trace",
      data: JSON.stringify({ status: outcome.trace, traceId: traceMeta.traceId }),
    });
    await stream.writeSSE({ event: "done", data: "{}" });
  });
});

// Graceful shutdown
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Agent] Received ${signal}, shutting down...`);
  try {
    // Destroy all active executors (sandbox containers)
    for (const [id, executor] of sessionExecutors) {
      await executor.destroy();
      sessionExecutors.delete(id);
    }
    await prisma.$disconnect();
    console.log("[Agent] Cleanup complete");
    process.exit(0);
  } catch (error) {
    console.error("[Agent] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("[Agent] TraceRoot Agent Service starting...");

  // Verify DB connection
  try {
    const count = await prisma.project.count();
    console.log(`[Agent] Connected to database. Found ${count} projects.`);
  } catch (error) {
    console.error("[Agent] Failed to connect to database:", error);
    process.exit(1);
  }

  // Sync standard model pricing from JSON → DB
  await syncStandardPrices();

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[Agent] Listening on http://localhost:${info.port}`);
  });
}

main().catch((error) => {
  console.error("[Agent] Fatal error:", error);
  process.exit(1);
});

export { app };
