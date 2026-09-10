import { beforeEach, describe, expect, it, vi } from "vitest";

// index.ts runs main() and binds a port at import time, so the process-level
// dependencies are stubbed before it loads. Everything the message route reaches
// is mocked too: the route's own decision is what is under test, not the agent,
// the sandbox, or the database.
vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

vi.mock("@traceroot/core", () => ({
  prisma: { project: { count: vi.fn().mockResolvedValue(0) }, $disconnect: vi.fn() },
  calculateCost: vi.fn().mockResolvedValue(0),
  syncStandardPrices: vi.fn().mockResolvedValue(undefined),
  ModelSource: { BYOK: "byok", SYSTEM: "system" },
}));

const appendMessage = vi.fn();

vi.mock("../session.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn().mockResolvedValue({ workspaceId: "ws-1", title: "existing" }),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

vi.mock("../agent.js", () => ({
  getOrCreateAgent: vi.fn().mockResolvedValue({ agent: {}, sessionManager: { appendMessage } }),
  // One text delta then done, which is the shortest path that still persists an
  // assistant row — the row whose kind is half of what this route decides.
  runAgent: vi.fn(async (_agent, _message, callbacks) => {
    callbacks.onEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "because the retry never backed off" },
    });
    await callbacks.onDone();
  }),
  removeAgent: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));

vi.mock("../prompts/system.js", () => ({ getSystemPrompt: vi.fn().mockReturnValue("system") }));
vi.mock("../executors/index.js", () => ({ createExecutor: vi.fn(() => ({ destroy: vi.fn() })) }));
vi.mock("../tools/index.js", () => ({ createTools: vi.fn(() => ({})) }));

const { app } = await import("../index.ts");

const URL_PATH = "/api/v1/projects/proj-1/sessions/sess-1/messages";

async function postMessage(headers: Record<string, string>) {
  const res = await app.request(URL_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-workspace-id": "ws-1", ...headers },
    body: JSON.stringify({ message: "why did this trace fail?" }),
  });
  // Draining the stream runs the SSE callback, which is where the assistant row
  // is written; without this the assertion would race the response.
  await res.text();
  return res;
}

function kindsPersisted() {
  return appendMessage.mock.calls.map((call) => ({ role: call[0], kind: call[2] }));
}

describe("POST messages — which meter the turn is billed to", () => {
  beforeEach(() => {
    appendMessage.mockClear();
  });

  it("bills a request carrying a user id as chat", async () => {
    await postMessage({ "x-user-id": "user-1" });

    expect(kindsPersisted()).toEqual([
      { role: "user", kind: "chat" },
      { role: "assistant", kind: "chat" },
    ]);
  });

  it("bills a request with no user id as rca", async () => {
    // The worker's automatic root-cause turn: it deliberately sends no x-user-id
    // so the session is created without an owner.
    await postMessage({});

    expect(kindsPersisted()).toEqual([
      { role: "user", kind: "rca" },
      { role: "assistant", kind: "rca" },
    ]);
  });

  it("bills a follow-up as chat even though the session has no owner", async () => {
    // The reported bug. getSession resolves this system session for both callers,
    // so nothing about the session distinguishes the two turns above — only the
    // header does, which is why the decision cannot be read off the session.
    await postMessage({ "x-user-id": "user-1" });

    expect(kindsPersisted().every((row) => row.kind === "chat")).toBe(true);
  });

  it("keeps a turn's two rows on the same meter", async () => {
    await postMessage({ "x-user-id": "user-1" });
    const kinds = kindsPersisted().map((row) => row.kind);

    expect(new Set(kinds).size).toBe(1);
  });
});
