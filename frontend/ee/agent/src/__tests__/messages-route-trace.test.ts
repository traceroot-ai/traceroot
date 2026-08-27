import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level regression test for the Global Constraint "with the flag off, a
// full cycle produces exactly the rows it does on main today": the messages
// route must call StreamPersister.finish() with NO trace argument at all when
// AGENT_SELF_TRACE is unset — not a present-but-"disabled" object — so
// finish()'s `!trace` gate behaves exactly as it did before self-trace
// existed. Everything except session.js/agent.js/system-prompt/executors/
// tools (irrelevant plumbing) and the HTTP server itself is left real,
// including self-trace.ts and stream-persister.ts — the two modules whose
// interaction this test exists to check.

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

vi.mock("@traceroot/core", async (orig) => ({
  ...(await orig<any>()),
  prisma: {
    project: { count: async () => 0 },
    detectorRcaExecution: { findUnique: async () => null },
  },
  syncStandardPrices: async () => {},
}));

const appendMessage = vi.fn(async () => ({ id: "user-row-1" }));
vi.mock("../session.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(async () => ({
    id: "s1",
    projectId: "p1",
    workspaceId: "w1",
    userId: "u1", // a user session — this is a plain chat turn
    executionId: null,
    title: "existing title",
  })),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

vi.mock("../agent.js", () => ({
  getOrCreateAgent: vi.fn(async () => ({
    agent: {},
    sessionManager: { appendMessage },
  })),
  // The route never awaits runAgent's own promise — resolution flows through
  // handler.onDone()/onError() — so firing onDone synchronously is enough to
  // drive the route to completion with no assistant text and no tool calls.
  runAgent: vi.fn((_agent: unknown, _message: string, handler: { onDone: () => void }) => {
    handler.onDone();
  }),
  removeAgent: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));

vi.mock("../prompts/system.js", () => ({ getSystemPrompt: () => "system prompt" }));
vi.mock("../executors/index.js", () => ({ createExecutor: () => ({ destroy: vi.fn() }) }));
vi.mock("../tools/index.js", () => ({ createTools: () => [] }));

describe("POST .../messages — disabled-tracing row parity", () => {
  const OLD_ENV = process.env.AGENT_SELF_TRACE;

  beforeEach(() => {
    delete process.env.AGENT_SELF_TRACE;
    delete process.env.AGENT_SELF_TRACE_KINDS;
    appendMessage.mockClear();
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.AGENT_SELF_TRACE;
    else process.env.AGENT_SELF_TRACE = OLD_ENV;
  });

  it("calls StreamPersister.finish with no trace argument when AGENT_SELF_TRACE is unset", async () => {
    const { StreamPersister } = await import("../stream-persister.js");
    const finishSpy = vi.spyOn(StreamPersister.prototype, "finish");

    const { app } = await import("../index.js");

    const res = await app.request("/api/v1/projects/p1/sessions/s1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": "u1",
        "x-workspace-id": "w1",
      },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(200);
    expect(finishSpy).toHaveBeenCalledTimes(1);
    // Second argument (the trace stamp) must be undefined, not an object with
    // status: "disabled" — passing a present-but-inert object would defeat
    // finish()'s `!trace` gate and force an extra empty assistant row.
    expect(finishSpy.mock.calls[0][1]).toBeUndefined();

    finishSpy.mockRestore();
  });
});
