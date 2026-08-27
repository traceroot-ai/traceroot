import { describe, it, expect, beforeEach, vi } from "vitest";

// index.ts runs main() (DB check, price sync, HTTP listen) at import time —
// mock everything it touches so importing `app` in a test is side-effect-free.
const mocks = vi.hoisted(() => ({
  appendMessage: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn(),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    project: { count: vi.fn().mockResolvedValue(0) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
  calculateCost: vi.fn().mockResolvedValue(0),
  syncStandardPrices: vi.fn().mockResolvedValue(undefined),
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));

vi.mock("../session.js", async () => {
  const actual = await vi.importActual<typeof import("../session.js")>("../session.js");
  return {
    ...actual,
    getSession: mocks.getSession,
    updateSessionTitle: mocks.updateSessionTitle,
    createSession: vi.fn(),
    getSessionMessages: vi.fn(),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
  };
});

// runAgent drives handler.onEvent/onDone the way the real pi-agent-core Agent
// would for a one-turn text reply, so the route's SSE callback runs its full
// persistence path (both appendMessage call sites) exactly as production does.
vi.mock("../agent.js", () => ({
  getOrCreateAgent: vi.fn().mockResolvedValue({
    agent: {},
    sessionManager: { appendMessage: mocks.appendMessage },
  }),
  runAgent: vi.fn(async (_agent: unknown, _userMessage: string, handler: any) => {
    handler.onEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi there" },
    });
    handler.onEvent({
      type: "message_end",
      message: {
        model: "gpt-5",
        provider: "openai",
        usage: { input: 10, output: 5, cost: { total: 0.01 } },
        stopReason: "stop",
      },
    });
    await handler.onDone();
  }),
  removeAgent: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));

vi.mock("../prompts/system.js", () => ({
  getSystemPrompt: vi.fn().mockReturnValue("system prompt"),
}));

vi.mock("../executors/index.js", () => ({
  createExecutor: vi.fn().mockReturnValue({ destroy: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("../tools/index.js", () => ({
  createTools: vi.fn().mockReturnValue([]),
}));

import { app } from "../index.js";

describe("POST /api/v1/projects/:projectId/sessions/:sessionId/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ workspaceId: "ws-1", title: "existing title" });
  });

  async function postMessage(headers: Record<string, string>) {
    const res = await app.request("/api/v1/projects/proj-1/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ message: "hello" }),
    });
    // Drain the SSE body: appendMessage("assistant", ...) is awaited before the
    // route writes its final "done" event, so reading to completion guarantees
    // both appendMessage calls have already landed.
    await res.text();
    return res;
  }

  it("a request without x-user-id (the worker's automatic RCA turn) persists kind='rca' for both messages", async () => {
    await postMessage({});

    expect(mocks.appendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.appendMessage.mock.calls[0]).toEqual(["user", "hello", "rca"]);
    expect(mocks.appendMessage.mock.calls[1][0]).toBe("assistant");
    expect(mocks.appendMessage.mock.calls[1][2]).toBe("rca");
  });

  it("a request with x-user-id (a human follow-up) persists kind='chat' for both messages", async () => {
    await postMessage({ "x-user-id": "user-1" });

    expect(mocks.appendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.appendMessage.mock.calls[0]).toEqual(["user", "hello", "chat"]);
    expect(mocks.appendMessage.mock.calls[1][0]).toBe("assistant");
    expect(mocks.appendMessage.mock.calls[1][2]).toBe("chat");
  });
});
