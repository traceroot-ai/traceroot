import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level tests for the messages route's self-trace seam. Everything
// except session.js/agent.js/system-prompt/executors/tools (irrelevant
// plumbing), the SDK and the HTTP server itself is left real, including
// self-trace.ts and stream-persister.ts — the two modules whose interaction
// these tests exist to check.
//
// Disabled: the route must call StreamPersister.finish() with NO trace
// argument at all when AGENT_SELF_TRACE is unset — not a present-but-
// "disabled" object — so finish()'s `!trace` gate behaves exactly as it did
// before self-trace existed (Global Constraint: with the flag off, a full
// cycle produces exactly the rows it does on main today).
//
// Enabled: finish() and the `trace` SSE frame carry the same trace id, the
// one observe() was forced to.

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

const observe = vi.fn(async (_opts: unknown, fn: () => unknown) => fn());
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: {
    initialize: vi.fn(),
    flush: vi.fn(async () => {}),
    isTracingActive: () => true,
  },
  observe: (...a: unknown[]) => observe(...(a as [unknown, () => unknown])),
  instrumentPiAgentCore: vi.fn(),
}));

const executionFindUnique = vi.fn();
vi.mock("@traceroot/core", async (orig) => ({
  ...(await orig<any>()),
  prisma: {
    project: { count: async () => 0 },
    detectorRcaExecution: { findUnique: (...a: unknown[]) => executionFindUnique(...a) },
  },
  syncStandardPrices: async () => {},
}));

const appendMessage = vi.fn(async () => ({ id: "user-row-1" }));
const getSession = vi.fn();
vi.mock("../session.js", () => ({
  createSession: vi.fn(),
  getSession: (...a: unknown[]) => getSession(...a),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  executionBelongsToProject: vi.fn(),
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

const userSession = {
  id: "s1",
  projectId: "p1",
  workspaceId: "w1",
  userId: "u1", // a user session — this is a plain chat turn
  executionId: null,
  title: "existing title",
};
const systemSession = { ...userSession, userId: null, executionId: "exec-1" };

async function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = { "x-user-id": "u1" },
) {
  const { StreamPersister } = await import("../stream-persister.js");
  const finishSpy = vi.spyOn(StreamPersister.prototype, "finish");
  const { app } = await import("../index.js");
  const res = await app.request("/api/v1/projects/p1/sessions/s1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-workspace-id": "w1", ...headers },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  // streamSSE runs the handler as a fire-and-forget task and app.request
  // resolves as soon as the handler returns, so finish() may not have been
  // called yet. Draining the response body waits for the stream the callback
  // writes — without it these assertions can pass on a callback that never
  // ran, which is the opposite of what they exist to check.
  const sse = await res.text();
  expect(finishSpy).toHaveBeenCalledTimes(1);
  const traceArg = finishSpy.mock.calls[0]![1];
  finishSpy.mockRestore();
  return { sse, traceArg, observeOpts: observe.mock.calls[0]?.[0] as any };
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.AGENT_SELF_TRACE;
  delete process.env.AGENT_SELF_TRACE_KINDS;
  process.env.INTERNAL_API_SECRET_AGENT = "s";
  appendMessage.mockClear();
  observe.mockClear();
  executionFindUnique.mockReset().mockResolvedValue({ traceId: "e".repeat(32), findingId: "f1" });
  getSession.mockReset().mockResolvedValue(userSession);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.AGENT_SELF_TRACE;
  vi.restoreAllMocks();
});

describe("POST .../messages — disabled-tracing row parity", () => {
  it("calls StreamPersister.finish with no trace argument when AGENT_SELF_TRACE is unset", async () => {
    const { traceArg } = await post({ message: "hi" });
    // Second argument (the trace stamp) must be undefined, not an object with
    // status: "disabled" — passing a present-but-inert object would defeat
    // finish()'s `!trace` gate and force an extra empty assistant row.
    expect(traceArg).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not read the parent execution for a follow-up that will not be traced", async () => {
    getSession.mockResolvedValue(systemSession);
    await post({ message: "and then?" });
    expect(executionFindUnique).not.toHaveBeenCalled();
  });
});

describe("POST .../messages — enabled", () => {
  beforeEach(() => {
    process.env.AGENT_SELF_TRACE = "1";
  });

  it("stamps finish() and the trace SSE frame with the id observe was forced to", async () => {
    const { sse, traceArg, observeOpts } = await post({ message: "hi" });
    expect(observeOpts).toMatchObject({ projectId: "p1", name: "chat" });
    const traceId = observeOpts.traceId as string;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceArg).toEqual({ traceId, status: "available" });
    expect(sse).toContain(
      `event: trace\ndata: ${JSON.stringify({ status: "available", traceId })}`,
    );
    expect(observeOpts.metadata).toEqual({ kind: "chat", session_id: "s1" });
  });

  it("links a follow-up to the execution that opened its session", async () => {
    getSession.mockResolvedValue(systemSession);
    const { observeOpts } = await post({ message: "and then?" });
    expect(executionFindUnique).toHaveBeenCalledWith({
      where: { id: "exec-1" },
      select: { traceId: true, findingId: true },
    });
    expect(observeOpts).toMatchObject({ name: "followup" });
    expect(observeOpts.metadata).toEqual({
      kind: "followup",
      session_id: "s1",
      execution_id: "exec-1",
      finding_id: "f1",
      parent_trace_id: "e".repeat(32),
    });
  });

  it("still traces (and completes) a follow-up when the parent lookup fails", async () => {
    getSession.mockResolvedValue(systemSession);
    executionFindUnique.mockRejectedValue(new Error("db down"));
    const { traceArg, observeOpts } = await post({ message: "and then?" });
    expect(traceArg).toMatchObject({ status: "available" });
    expect(observeOpts.metadata).toEqual({
      kind: "followup",
      session_id: "s1",
      execution_id: "exec-1",
    });
  });

  it("traces an execution turn under the worker's trace id and finding metadata", async () => {
    getSession.mockResolvedValue(systemSession);
    const agentTrace = {
      traceId: "c".repeat(32),
      kind: "rca",
      metadata: { finding_id: "f1", execution_id: "exec-1", attempt: 1, detectors: ["det1"] },
    };
    const { sse, traceArg, observeOpts } = await post({ message: "analyse", agentTrace }, {});
    expect(executionFindUnique).not.toHaveBeenCalled();
    expect(observeOpts).toMatchObject({ traceId: "c".repeat(32), name: "rca: det1" });
    expect(observeOpts.metadata).toEqual({
      kind: "rca",
      finding_id: "f1",
      execution_id: "exec-1",
      attempt: 1,
      detectors: ["det1"],
      session_id: "s1",
    });
    expect(traceArg).toEqual({ traceId: "c".repeat(32), status: "available" });
    expect(sse).toContain(`"traceId":"${"c".repeat(32)}"`);
  });

  it("ignores a worker-style agentTrace on a chat turn", async () => {
    const { observeOpts } = await post({
      message: "hi",
      agentTrace: { traceId: "c".repeat(32), kind: "rca", metadata: {} },
    });
    expect(observeOpts.traceId).not.toBe("c".repeat(32));
    expect(observeOpts.name).toBe("chat");
  });
});
