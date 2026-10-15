import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { app, shutdown } from "../index.js";
import { rememberListener } from "../hot-reload.js";
import { getSession } from "../session.js";
import { getOrCreateAgent, runAgent } from "../agent.js";
import { createExecutor } from "../executors/index.js";

const listener = vi.hoisted(() => ({
  closeCalls: 0,
  closeAllCalls: 0,
  close(cb?: (error?: Error) => void) {
    listener.closeCalls += 1;
    cb?.();
  },
  closeAllConnections() {
    listener.closeAllCalls += 1;
  },
}));

const disconnect = vi.hoisted(() => vi.fn(async () => {}));
const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

// The real shutdown sequence against mocked boundaries: a controllable
// listener, spied executors, and a parked run for the in-flight request.
vi.mock("@traceroot/core", () => ({
  prisma: {
    project: { count: async () => 0 },
    $disconnect: (...args: unknown[]) => disconnect(...args),
  },
  syncStandardPrices: vi.fn(async () => {}),
  calculateCost: vi.fn(async () => 0),
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));
vi.mock("@hono/node-server", () => ({
  serve: () => listener,
}));
vi.mock("../session.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionTitle: vi.fn(async () => ({})),
  executionBelongsToProject: vi.fn(),
}));
vi.mock("../agent.js", () => ({
  getOrCreateAgent: vi.fn(),
  runAgent: vi.fn(),
  removeAgent: vi.fn(),
  abortSessionRun: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));
vi.mock("../executors/index.js", () => ({
  createExecutor: vi.fn(() => ({
    init: vi.fn(async () => {}),
    isReady: vi.fn(() => false),
    destroy: vi.fn(async () => {}),
  })),
}));
vi.mock("../tools/index.js", () => ({
  createTools: vi.fn(() => []),
}));
vi.mock("../prompts/system.js", () => ({
  getSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const mockedRunAgent = vi.mocked(runAgent);

function post(sessionId: string) {
  return app.request(`/api/v1/projects/p1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": "u1" },
    body: JSON.stringify({ message: "hello" }),
  });
}

function destroySpies() {
  return vi
    .mocked(createExecutor)
    .mock.results.map((result) => (result.value as { destroy: Mock }).destroy);
}

beforeEach(() => {
  // Implementations are (re)set here; calls intentionally accumulate across
  // this file's tests — the retry test asserts totals from the first test's
  // shutdown, so no clearing happens between them. Test files are isolated
  // from each other by the runner.
  vi.mocked(getSession).mockImplementation(
    async (id) => ({ id, userId: "u1", projectId: "p1", workspaceId: "w1", title: "t" }) as never,
  );
  vi.mocked(getOrCreateAgent).mockImplementation(
    async () =>
      ({ agent: {}, sessionManager: { appendMessage: vi.fn(async () => ({})) } }) as never,
  );
  mockedRunAgent.mockImplementation(async (_agent, _message, handler) => {
    handler.onDone();
  });
});

describe("shutdown executor race", () => {
  // The first test's destroy spy survives into the retry test (clearAllMocks
  // wipes mock.results, so it is captured, not re-queried).
  let seenDestroy: Mock | undefined;
  it("destroys the in-flight request's executor exactly once and refuses late requests", async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let runStarted = false;
    mockedRunAgent.mockImplementationOnce(async (_agent, _message, handler) => {
      runStarted = true;
      await runGate;
      handler.onDone();
    });

    // A request is inside its run (executor registered) when SIGTERM lands.
    const first = post("shut-1");
    await vi.waitFor(() => expect(runStarted).toBe(true));
    await vi.waitFor(() => expect(vi.mocked(createExecutor)).toHaveBeenCalledTimes(1));

    // main() remembers the listener returned by serve(); replicate that
    // wiring so shutdown closes the real handle.
    rememberListener(listener);
    await shutdown("SIGTERM");

    // The listener stopped accepting work and the one executor was destroyed
    // exactly once, even though its run is still in flight.
    expect(listener.closeCalls).toBe(1);
    expect(listener.closeAllCalls).toBe(1);
    const destroyed = destroySpies();
    expect(destroyed.map((spy) => spy.mock.calls.length)).toEqual([1]);
    seenDestroy = destroyed[0];
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // A request arriving after shutdown began is refused before it can
    // register an executor the cleanup will never see.
    const late = await post("shut-2");
    expect(late.status).toBe(503);
    expect(await late.json()).toEqual({ error: "agent is shutting down" });
    expect(vi.mocked(createExecutor)).toHaveBeenCalledTimes(1);

    // Let the parked run finish so it releases its claim cleanly.
    releaseRun();
    await (await first).text();
  });

  it("ignores a repeated signal without destroying twice", async () => {
    await shutdown("SIGINT");

    expect(seenDestroy?.mock.calls.length).toBe(1);
    expect(listener.closeCalls).toBe(1);
    // No second exit: the first shutdown already owns the process teardown.
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
