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
  type TurnAttribution,
} from "./session.js";
import { getOrCreateAgent, runAgent, removeAgent, invalidateProviderCache } from "./agent.js";
import { StreamPersister } from "./stream-persister.js";
import { UsageAccumulator } from "./usage-accumulator.js";
import { getSystemPrompt } from "./prompts/system.js";
import { createExecutor } from "./executors/index.js";
import { createTools } from "./tools/index.js";
import type { Executor } from "./executors/interface.js";

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
  const body = await c.req.json<{ title?: string; executionId?: string }>();

  const session = await createSession({
    projectId,
    workspaceId,
    userId, // undefined → stored as null for system/RCA sessions
    title: body.title,
    executionId: body.executionId,
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
  const attribution: TurnAttribution =
    ownedSession.userId === null
      ? userId
        ? {
            turnKind: "rca_followup",
            executionId: ownedSession.executionId,
            initiatorUserId: userId,
          }
        : {
            turnKind: "rca_execution",
            executionId: ownedSession.executionId,
            initiatorUserId: null,
          }
      : { turnKind: "chat", initiatorUserId: userId || null };

  // Persist user message to DB via SessionManager
  await sessionManager.appendMessage("user", body.message, undefined, undefined, attribution);

  // Auto-generate session title from first user message (we already have
  // the session loaded above for the auth check — reuse it).
  if (!ownedSession.title) {
    const title = body.message.slice(0, 80) + (body.message.length > 80 ? "..." : "");
    await updateSessionTitle(sessionId, title);
  }

  return streamSSE(c, async (stream) => {
    // Mirrors the run into AIMessage rows (text segments, tool steps) so
    // reloaded history matches what the live stream rendered.
    const persister = new StreamPersister((role, content, metadata, tokenUsage) =>
      sessionManager.appendMessage(role, content, metadata, tokenUsage, attribution),
    );
    // Accumulates token usage across all message_end events (tool-use loops)
    const usageAccumulator = new UsageAccumulator();
    let loggedFirstUpdate = false;

    await new Promise<void>((resolve) => {
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
        onError: async (error) => {
          console.error(`[Agent] ERROR:`, error.message);
          stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: error.message }),
          });
          // Persist whatever the run produced before failing (text so far,
          // completed tool steps) so reloaded history matches what was shown,
          // with the usage accumulated before the failure so those tokens
          // still count toward the run meters.
          await persister.finish(
            await usageAccumulator.toTokenUsage(body.source === ModelSource.BYOK),
          );
          resolve();
        },
        onDone: async () => {
          const tokenUsage = await usageAccumulator.toTokenUsage(body.source === ModelSource.BYOK);
          // Flush the trailing text segment and wait for all rows to land
          await persister.finish(tokenUsage);
          console.log(`[Agent] Done. Run persisted for session ${sessionId}`);
          stream.writeSSE({ event: "done", data: "{}" });
          resolve();
        },
      });
    });
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
