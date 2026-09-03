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
} from "./session.js";
import { getOrCreateAgent, removeAgent, invalidateProviderCache } from "./agent.js";
import { decisionsRoute } from "./decisions-route.js";
import { pendingDecisions, SESSION_DELETED_SKIP_REASON } from "./pending-decisions.js";
import { claimRun, releaseRun, runAgentStream } from "./run-stream.js";
import { getSystemPrompt } from "./prompts/system.js";
import { createExecutor } from "./executors/index.js";
import { createTools } from "./tools/index.js";
import type { Executor } from "./executors/interface.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "./session.js";

const app = new Hono();

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";
const PORT = parseInt(new URL(AGENT_SERVICE_URL).port || "8100", 10);

// Per-session executor cache (executor lifecycle tied to session)
const sessionExecutors = new Map<string, Executor>();

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
  const body = await c.req.json<{ title?: string }>();

  const session = await createSession({
    projectId,
    workspaceId,
    userId, // undefined → stored as null for system/RCA sessions
    title: body.title,
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

  // The session is gone — any tool call still parked on a confirmation for
  // it can never receive a decision, so release it as a skip.
  pendingDecisions.releaseSession(sessionId, SESSION_DELETED_SKIP_REASON);

  // Destroy executor if one exists for this session
  const executor = sessionExecutors.get(sessionId);
  if (executor) {
    await executor.destroy();
    sessionExecutors.delete(sessionId);
  }

  removeAgent(sessionId);
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
  }>();

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
  });

  // Get or create executor for this session (lazy — not initialized until tool use)
  let executor = sessionExecutors.get(sessionId);
  if (!executor) {
    executor = createExecutor();
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

  let agent: Agent;
  let sessionManager: SessionManager;
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

    // Persist user message to DB via SessionManager
    await sessionManager.appendMessage("user", body.message);

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

// Under vitest the app is exercised via app.request — don't boot the server.
if (!process.env.VITEST) {
  main().catch((error) => {
    console.error("[Agent] Fatal error:", error);
    process.exit(1);
  });
}

export { app };
