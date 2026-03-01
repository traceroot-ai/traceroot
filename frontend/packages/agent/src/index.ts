import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { prisma } from "@traceroot/core";
import {
  createSession,
  getSession,
  getSessionMessages,
  listSessions,
  deleteSession,
  updateSessionTitle,
} from "./session.js";
import { getOrCreateAgent, runAgent, removeAgent, invalidateProviderCache } from "./agent.js";
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
  const { workspaceId, providerName } = await c.req.json<{ workspaceId: string; providerName: string }>();
  if (!workspaceId || !providerName) {
    return c.json({ error: "workspaceId and providerName required" }, 400);
  }
  invalidateProviderCache(workspaceId, providerName);
  console.log(`[Agent] Cache invalidated for provider "${providerName}" in workspace ${workspaceId}`);
  return c.json({ ok: true });
});

// Session CRUD routes
app.post("/api/v1/projects/:projectId/sessions", async (c) => {
  const projectId = c.req.param("projectId");
  const userId = c.req.header("x-user-id") || "";
  const workspaceId = c.req.header("x-workspace-id") || "";
  const body = await c.req.json<{ title?: string }>();

  const session = await createSession({
    projectId,
    workspaceId,
    userId,
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
  const session = await getSession(c.req.param("sessionId"), userId);
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json(session);
});

// GET messages for a session (for loading history in UI)
app.get("/api/v1/projects/:projectId/sessions/:sessionId/messages", async (c) => {
  const userId = c.req.header("x-user-id") || "";
  const messages = await getSessionMessages(c.req.param("sessionId"), userId);
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
    providerName?: string;
    source?: "system" | "byok";
  }>();

  const systemPrompt = getSystemPrompt({ projectId, traceId: body.traceId });

  // Get or create executor for this session (lazy — not initialized until tool use)
  let executor = sessionExecutors.get(sessionId);
  if (!executor) {
    executor = createExecutor();
    sessionExecutors.set(sessionId, executor);
  }

  const tools = createTools({ projectId, userId, executor });

  console.log(
    `[Agent] POST message: session=${sessionId}, model=${body.model}, provider=${body.providerName}, source=${body.source}`,
  );

  const { agent, sessionManager } = await getOrCreateAgent({
    sessionId,
    projectId,
    workspaceId,
    userId,
    systemPrompt,
    tools,
    model: body.model,
    providerName: body.providerName,
    source: body.source,
  });

  console.log(`[Agent] Agent ready, running prompt: "${body.message.slice(0, 50)}"`);

  // Persist user message to DB via SessionManager
  await sessionManager.appendMessage("user", body.message);

  // Auto-generate session title from first user message
  const session = await getSession(sessionId, userId);
  if (session && !session.title) {
    const title = body.message.slice(0, 80) + (body.message.length > 80 ? "..." : "");
    await updateSessionTitle(sessionId, title);
  }

  return streamSSE(c, async (stream) => {
    let assistantText = "";

    await new Promise<void>((resolve) => {
      runAgent(agent, body.message, {
        onEvent: (event) => {
          if (event.type === "message_update") {
            // Log first delta to inspect event structure
            if (!assistantText) {
              console.log(`[Agent] First message_update:`, JSON.stringify(event).slice(0, 500));
            }
          } else {
            console.log(`[Agent] Event: ${event.type}`);
          }
          // Log error details from failed API calls
          if (event.type === "message_end") {
            const msg = (event as any).message;
            if (msg?.stopReason === "error") {
              console.error(`[Agent] API error:`, msg.errorMessage || "unknown");
            }
          }
          // Forward all events to the frontend
          stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });

          // Accumulate assistant text for DB persistence
          if (event.type === "message_update") {
            const msgEvent = event as any;
            const delta = msgEvent.assistantMessageEvent;
            if (delta?.type === "text_delta") {
              assistantText += delta.delta;
            }
          }
        },
        onError: (error) => {
          console.error(`[Agent] ERROR:`, error.message);
          stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: error.message }),
          });
          resolve();
        },
        onDone: async () => {
          console.log(`[Agent] Done. Assistant text length: ${assistantText.length}`);
          // Persist assistant response to DB via SessionManager
          if (assistantText) {
            await sessionManager.appendMessage("assistant", assistantText);
          }
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

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[Agent] Listening on http://localhost:${info.port}`);
  });
}

main().catch((error) => {
  console.error("[Agent] Fatal error:", error);
  process.exit(1);
});

export { app };
