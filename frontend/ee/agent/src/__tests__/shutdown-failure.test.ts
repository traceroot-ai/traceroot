import { describe, expect, it, vi } from "vitest";
import { app, shutdown } from "../index.js";
import { rememberListener } from "../hot-reload.js";
import { createExecutor } from "../executors/index.js";

const listener = vi.hoisted(() => ({
  closeCalls: 0,
  close(cb?: (error?: Error) => void) {
    listener.closeCalls += 1;
    cb?.();
  },
  closeAllConnections() {},
}));

const disconnect = vi.hoisted(() => vi.fn(async () => {}));
const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

// A fresh module registry (separate file), so the shutdown flag starts clear
// and the exit-1 path can be driven through the real sequence.
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
  getSession: vi.fn(
    async (id: string) =>
      ({ id, userId: "u1", projectId: "p1", workspaceId: "w1", title: "t" }) as never,
  ),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionTitle: vi.fn(async () => ({})),
  executionBelongsToProject: vi.fn(),
}));
vi.mock("../agent.js", () => ({
  getOrCreateAgent: vi.fn(
    async () =>
      ({ agent: {}, sessionManager: { appendMessage: vi.fn(async () => ({})) } }) as never,
  ),
  runAgent: vi.fn(async (_agent: unknown, _message: string, handler: { onDone(): void }) => {
    handler.onDone();
  }),
  removeAgent: vi.fn(),
  abortSessionRun: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));
vi.mock("../executors/index.js", () => ({
  createExecutor: vi.fn(() => ({
    init: vi.fn(async () => {}),
    isReady: vi.fn(() => false),
    destroy: vi.fn(async () => {
      throw new Error("Cannot connect to the Docker daemon");
    }),
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

describe("shutdown with failing cleanup", () => {
  it("still disconnects and exits nonzero when a sandbox removal fails", async () => {
    const res = await app.request("/api/v1/projects/p1/sessions/shut-f/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "u1" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(vi.mocked(createExecutor)).toHaveBeenCalledTimes(1);

    rememberListener(listener);
    await shutdown("SIGTERM");

    expect(listener.closeCalls).toBe(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    // The failure is reported, not swallowed: the process exits nonzero so
    // the leak is visible instead of a false clean shutdown.
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
