import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { prisma, syncStandardPrices, ModelSource } from "@traceroot/core";
import { publicErrorMessage } from "@traceroot/core/public-error";
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
import {
  getOrCreateAgent,
  removeAgent,
  abortSessionRun,
  invalidateProviderCache,
} from "./agent.js";
import { decisionsRoute } from "./decisions-route.js";
import { pendingDecisions, SESSION_DELETED_SKIP_REASON } from "./pending-decisions.js";
import { claimRun, releaseRun, runAgentStream, waitForRunToSettle } from "./run-stream.js";
import {
  isAgentTraceEnabled,
  turnTraceId,
  ROOT_SPAN_NAME,
  type AgentTraceMeta,
  type AgentTraceKind,
} from "./self-trace.js";
import { getSystemPrompt } from "./prompts/system.js";
import { createExecutor } from "./executors/index.js";
import {
  clearSessionDeleted,
  fenceExecutorToSession,
  markSessionDeleted,
} from "./executors/deleted-session-fence.js";
import { createTools } from "./tools/index.js";
import {
  closePreviousListener,
  registerSignalHandlers,
  rememberExecutors,
  rememberListener,
} from "./hot-reload.js";
import { parseQueryWindow } from "./tools/query-window.js";
import type { Executor } from "./executors/interface.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "./session.js";

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

// When this module was (re-)executed. Reported by /health so a caller can tell
// whether the running process predates the sources it is being graded against
// — the eval harness refuses to score a service older than its own code.
const BOOT_TIME = new Date().toISOString();

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "traceroot-agent", startedAt: BOOT_TIME });
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

  // Authorize first: deleteSession only removes a session the caller owns
  // in this project. Tearing down the executor and agent before that check
  // would let any project member holding a session id destroy another
  // user's sandbox by way of a 404.
  const result = await deleteSession(sessionId, userId, c.req.param("projectId"));
  if (!result) return c.json({ error: "not found" }, 404);

  // Mark BEFORE anything resumes the run: releasing a parked decision below
  // hands control back to the turn in a microtask, and the mark is what stops
  // its next sandbox tool call from re-creating a container (see the fence).
  markSessionDeleted(sessionId);
  // The turn has nobody left to narrate to and would keep spending tokens.
  abortSessionRun(sessionId);
  // The session is gone — any tool call still parked on a confirmation for
  // it can never receive a decision, so release it as a skip.
  pendingDecisions.releaseSession(sessionId, SESSION_DELETED_SKIP_REASON);

  // Only now is the executor safe to tear down: destroying it while the
  // resumed run is still executing tools would leave the sandbox that run
  // re-creates untracked, and leaked for the life of the process.
  const settled = await waitForRunToSettle(sessionId);

  try {
    const executor = sessionExecutors.get(sessionId);
    if (executor) {
      // Untracked before destroy: a teardown that throws must not leave a
      // dead executor in the map for a later request to hand out.
      sessionExecutors.delete(sessionId);
      await executor.destroy();
    }
    removeAgent(sessionId);
  } finally {
    // The fence must never outlive the request that raised it, even when the
    // teardown throws: a stale mark refuses every later run's sandbox. The one
    // case it must outlive the request is a run that outlived the wait — it is
    // still live, and its next sandbox call would create a container nothing
    // tracks. That run drops its own mark when it settles.
    if (settled) clearSessionDeleted(sessionId);
  }
  return c.json({ ok: true });
});

// Confirmation decisions for parked confirm-class tool calls
app.route("/", decisionsRoute);

// Message route — SSE streaming via agent runner
app.post("/api/v1/projects/:projectId/sessions/:sessionId/messages", async (c) => {
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  const userId = c.req.header("x-user-id") || "";
  const body = await c.req.json<{
    message: string;
    model?: string;
    traceId?: string;
    traceSessionId?: string;
    providerName?: string;
    source?: ModelSource;
    agentTrace?: { traceId: string; kind: "rca"; metadata: Record<string, unknown> };
    /** The page's selected time range: a preset id, or custom bounds. */
    range?: string;
    start_time?: string;
    end_time?: string;
  }>();

  // The window the page is showing rides with each message and becomes the
  // default for the dashboard reads. Malformed is a 400, never a silent
  // default: the caller asked for a window and would get another one's numbers.
  const window = parseQueryWindow({
    range: body.range,
    start_time: body.start_time,
    end_time: body.end_time,
  });
  if (window instanceof Error) {
    return c.json({ error: `invalid window: ${window.message}` }, 400);
  }

  // Authorize first: caller must own the session in THIS project (user-bound)
  // or have projectId scope on a system session — getSession treats a
  // session/project mismatch exactly like a missing session. Without this
  // check, any caller who can reach the proxy could append messages and run
  // the LLM in another user's session by guessing/known sessionIds.
  const ownedSession = await getSession(sessionId, userId, projectId);
  if (!ownedSession) {
    return c.json({ error: "session not found" }, 404);
  }

  const systemPrompt = getSystemPrompt({
    projectId: ownedSession.projectId,
    traceId: body.traceId,
    traceSessionId: body.traceSessionId,
    // The same window the read tools default to, stated in the prompt so the
    // model can tell whether omitting it actually answers the question.
    window,
  });

  // Get or create executor for this session (lazy — not initialized until tool use)
  let executor = sessionExecutors.get(sessionId);
  if (!executor) {
    executor = fenceExecutorToSession(createExecutor(), sessionId);
    sessionExecutors.set(sessionId, executor);
  }

  // Both tenancy ids come from the ONE session row authorized above — never
  // the raw header or the raw path value — so tools can't be coerced into
  // another workspace, and projectId/workspaceId can't name two unrelated
  // tenancies. (getSession already guarantees session.projectId matches the
  // path; deriving from the row makes that structural.)
  const tools = createTools({
    projectId: ownedSession.projectId,
    userId,
    workspaceId: ownedSession.workspaceId,
    agentSessionId: sessionId,
    executor,
    window,
  });

  console.log(
    `[Agent] POST message: session=${sessionId}, model=${body.model}, provider=${body.providerName}, source=${body.source}`,
  );

  // One run per session at a time. Claimed before the user row lands and
  // before the cached agent's tools/prompt are refreshed under a live run;
  // runAgentStream releases the claim when the run settles.
  if (!claimRun(sessionId)) {
    return c.json({ error: "a run is already in progress for this session" }, 409);
  }

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

  let agent: Agent;
  let sessionManager: SessionManager;
  // The user row's id is this turn's messageId, used below to derive a
  // deterministic trace id for follow-up and chat turns.
  let userRow: Awaited<ReturnType<SessionManager["appendMessage"]>>;
  try {
    ({ agent, sessionManager } = await getOrCreateAgent({
      sessionId,
      projectId: ownedSession.projectId,
      workspaceId: ownedSession.workspaceId,
      userId,
      systemPrompt,
      tools,
      model: body.model,
      providerName: body.providerName,
      source: body.source,
    }));

    console.log(`[Agent] Agent ready, running prompt: "${body.message.slice(0, 50)}"`);

    // Persist user message to DB via SessionManager, attributed to this turn
    userRow = await sessionManager.appendMessage("user", body.message, attribution);

    // Auto-generate session title from first user message (we already have
    // the session loaded above for the auth check — reuse it).
    if (!ownedSession.title) {
      const title = body.message.slice(0, 80) + (body.message.length > 80 ? "..." : "");
      await updateSessionTitle(sessionId, title);
    }
  } catch (error) {
    // The run never started, so nothing else will release the claim.
    releaseRun(sessionId);
    throw error;
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
    name: ROOT_SPAN_NAME,
    input: body.message,
    metadata: {
      ...rcaTrace?.metadata,
      session_id: sessionId,
      ...(ownedSession.executionId ? { execution_id: ownedSession.executionId } : {}),
      ...(parent ? { finding_id: parent.findingId, parent_trace_id: parent.traceId } : {}),
    },
  };

  return streamSSE(c, (stream) =>
    runAgentStream(stream, {
      agent,
      message: body.message,
      sessionId,
      // Attended means THIS request comes from a user who can answer
      // confirmation cards — independent of who owns the session row, since
      // a signed-in user may continue a system/RCA session (owner null).
      // Only a user-less caller is unattended.
      channelUserId: userId,
      isByok: body.source === ModelSource.BYOK,
      sessionManager,
      attribution,
      trace: traceMeta,
    }),
  );
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

async function main(): Promise<void> {
  console.log("[Agent] TraceRoot Agent Service starting...");

  // First, before anything slow: under `vite-node --watch` this module is
  // re-executed in the same process, so the previous execution's listener is
  // still holding the port and its signal handlers are still registered.
  // Leaving them in place makes serve() below throw EADDRINUSE and the
  // process goes on serving the code it booted with.
  await closePreviousListener();
  registerSignalHandlers(["SIGTERM", "SIGINT"], (signal) => {
    void shutdown(signal);
  });
  rememberExecutors(sessionExecutors);

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

  rememberListener(
    serve({ fetch: app.fetch, port: PORT }, (info) => {
      console.log(`[Agent] Listening on http://localhost:${info.port}`);
    }),
  );
}

// Under vitest the app is exercised via app.request — don't boot the server.
if (!process.env.VITEST) {
  main().catch((error) => {
    console.error("[Agent] Fatal error:", error);
    process.exit(1);
  });
}

export { app };
