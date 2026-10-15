import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, runStartupReconciliation } from "../index.js";
import { startupGate } from "../executors/sandbox-lifecycle.js";
import { reconcileStaleSandboxes } from "../executors/sandbox-lifecycle.js";
import { getSession } from "../session.js";
import { getOrCreateAgent, runAgent } from "../agent.js";
import { createExecutor } from "../executors/index.js";
import { createTools } from "../tools/index.js";

// The real startup gate and the real message route, with only Docker timing
// under test control: reconcile is mocked (deferred or failing) while the
// gate object stays the production singleton both sides share.
vi.mock("@traceroot/core", () => ({
  prisma: { project: { count: async () => 0 }, $disconnect: vi.fn(async () => {}) },
  syncStandardPrices: vi.fn(async () => {}),
  calculateCost: vi.fn(async () => 0),
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));
vi.mock("@hono/node-server", () => ({ serve: () => ({}) }));
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
vi.mock("../executors/sandbox-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executors/sandbox-lifecycle.js")>();
  return {
    ...actual,
    reconcileStaleSandboxes: vi.fn(async () => ({ removed: [], failed: [], skippedActive: [] })),
  };
});
vi.mock("../tools/index.js", () => ({
  createTools: vi.fn(() => []),
}));
vi.mock("../prompts/system.js", () => ({
  getSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const mockedGetSession = vi.mocked(getSession);
const mockedReconcile = vi.mocked(reconcileStaleSandboxes);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function post(sessionId: string) {
  return app.request(`/api/v1/projects/p1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": "u1" },
    body: JSON.stringify({ message: "hello" }),
  });
}

beforeEach(() => {
  mockedGetSession.mockImplementation(
    async (id) => ({ id, userId: "u1", projectId: "p1", workspaceId: "w1", title: "t" }) as never,
  );
  vi.mocked(getOrCreateAgent).mockImplementation(
    async () =>
      ({ agent: {}, sessionManager: { appendMessage: vi.fn(async () => ({})) } }) as never,
  );
  vi.mocked(runAgent).mockImplementation(async (_agent, _message, handler) => {
    handler.onDone();
  });
});

afterEach(() => {
  // No test may leave the shared gate closed: the next test's requests would
  // hang at it.
  startupGate.release();
  vi.clearAllMocks();
});

describe("startup reconciliation gate", () => {
  it("leaves health answers untouched while the gate is closed", async () => {
    startupGate.close();
    try {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
    } finally {
      startupGate.release();
    }
  });

  it("holds sandbox-creating requests until the scan finishes, then lets them through", async () => {
    let releaseScan!: (value: { removed: []; failed: []; skippedActive: [] }) => void;
    const scanPending = new Promise<{ removed: []; failed: []; skippedActive: [] }>((resolve) => {
      releaseScan = resolve;
    });
    mockedReconcile.mockReturnValueOnce(scanPending);

    const startup = runStartupReconciliation();
    await tick();
    expect(startupGate.isOpen()).toBe(false);
    expect(mockedReconcile).toHaveBeenCalledTimes(1);

    // A request arriving mid-scan parks before executor creation.
    const pending = post("gate-1");
    await tick();
    await tick();
    expect(vi.mocked(createTools)).not.toHaveBeenCalled();

    // The scan completes: the gate opens and the parked request proceeds.
    releaseScan({ removed: [], failed: [], skippedActive: [] });
    await startup;
    expect(startupGate.isOpen()).toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    await res.text();
    expect(vi.mocked(createTools)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createExecutor)).toHaveBeenCalledTimes(1);
  });

  it("releases the gate even when reconciliation fails, preserving best-effort startup", async () => {
    mockedReconcile.mockRejectedValueOnce(new Error("Cannot connect to the Docker daemon"));

    // Must resolve, not throw: Docker being down delays requests, never
    // refuses them.
    await runStartupReconciliation();
    expect(startupGate.isOpen()).toBe(true);

    const res = await post("gate-2");
    expect(res.status).toBe(200);
    await res.text();
    expect(vi.mocked(createTools)).toHaveBeenCalledTimes(1);
  });
});
