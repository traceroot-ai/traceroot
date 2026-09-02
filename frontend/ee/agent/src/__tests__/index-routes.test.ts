import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.js";
import { pendingDecisions, SESSION_DELETED_SKIP_REASON } from "../pending-decisions.js";
import { deleteSession, getSession } from "../session.js";
import { runAgent, type AgentEventHandler } from "../agent.js";
import { createTools } from "../tools/index.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

vi.mock("@traceroot/core", () => ({
  prisma: {},
  syncStandardPrices: vi.fn(async () => {}),
  calculateCost: vi.fn(async () => 0),
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));
vi.mock("../session.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionTitle: vi.fn(),
}));
vi.mock("../agent.js", () => ({
  getOrCreateAgent: vi.fn(async () => ({
    agent: {},
    sessionManager: { appendMessage: vi.fn(async () => ({})) },
  })),
  runAgent: vi.fn(),
  removeAgent: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));
vi.mock("../executors/index.js", () => ({
  createExecutor: vi.fn(() => ({ destroy: vi.fn(async () => {}) })),
}));
vi.mock("../tools/index.js", () => ({
  createTools: vi.fn(() => []),
}));
vi.mock("../prompts/system.js", () => ({
  getSystemPrompt: vi.fn(() => "system prompt"),
}));

const mockedGetSession = vi.mocked(getSession);
const mockedDeleteSession = vi.mocked(deleteSession);
const mockedRunAgent = vi.mocked(runAgent);

function park(sessionId: string) {
  return pendingDecisions.park({
    sessionId,
    toolCallId: "tc-1",
    toolName: "create_detector",
    args: {},
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DELETE session — release path", () => {
  it("resolves parked decisions as skip when the session is deleted", async () => {
    mockedDeleteSession.mockResolvedValue({ id: "del-1" } as never);
    const { outcome } = park("del-1");

    const res = await app.request("/api/v1/projects/p1/sessions/del-1", {
      method: "DELETE",
      headers: { "x-user-id": "u1" },
    });

    expect(res.status).toBe(200);
    await expect(outcome).resolves.toEqual({
      action: "skip",
      reason: SESSION_DELETED_SKIP_REASON,
    });
    expect(pendingDecisions.pendingCount("del-1")).toBe(0);
  });

  it("does not release decisions when the caller does not own the session", async () => {
    mockedDeleteSession.mockResolvedValue(null as never);
    park("del-2");

    const res = await app.request("/api/v1/projects/p1/sessions/del-2", {
      method: "DELETE",
      headers: { "x-user-id": "intruder" },
    });

    expect(res.status).toBe(404);
    expect(pendingDecisions.pendingCount("del-2")).toBe(1);
    pendingDecisions.releaseSession("del-2", "test cleanup");
  });
});

describe("decisions endpoint is mounted on the service app", () => {
  it("accepts a decision through the full app", async () => {
    mockedGetSession.mockResolvedValue({ id: "mount-1" } as never);
    const { decisionId, outcome } = park("mount-1");

    const res = await app.request("/api/v1/projects/p1/sessions/mount-1/decisions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "u1" },
      body: JSON.stringify({ decisionId, action: "create" }),
    });

    expect(res.status).toBe(200);
    await expect(outcome).resolves.toEqual({ action: "create" });
  });
});

describe("messages route tenancy", () => {
  it("scopes the session lookup to the path's project and 404s a mismatch", async () => {
    // getSession itself rejects an owned session addressed through another
    // project (see session-tenancy tests); the route must feed it the path's
    // projectId and treat the rejection exactly like a missing session.
    mockedGetSession.mockResolvedValue(null as never);

    const res = await app.request("/api/v1/projects/pB/sessions/s-owned/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "u1" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(404);
    expect(mockedGetSession).toHaveBeenCalledWith("s-owned", "u1", "pB");
    expect(vi.mocked(createTools)).not.toHaveBeenCalled();
  });

  it("builds tools from the ONE authorized session row, never a mixed tenancy", async () => {
    // The session row is the single source of truth for both ids: even if the
    // lookup constraint regressed (simulated here by a mock that ignores the
    // path), tools must not combine the URL's projectId with the session's
    // workspaceId.
    mockedGetSession.mockResolvedValue({
      id: "s-owned",
      userId: "u1",
      projectId: "p-session",
      workspaceId: "w-session",
      title: "t",
    } as never);
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handler.onDone();
    });

    const res = await app.request("/api/v1/projects/p-url/sessions/s-owned/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": "u1",
        "x-workspace-id": "w-header",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(vi.mocked(createTools)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-session", workspaceId: "w-session" }),
    );
  });
});

describe("DELETE session tenancy", () => {
  it("passes the path's project to the ownership check", async () => {
    mockedDeleteSession.mockResolvedValue(null as never);

    const res = await app.request("/api/v1/projects/pB/sessions/s-owned", {
      method: "DELETE",
      headers: { "x-user-id": "u1" },
    });

    expect(res.status).toBe(404);
    expect(mockedDeleteSession).toHaveBeenCalledWith("s-owned", "u1", "pB");
  });
});

describe("messages route SSE stream", () => {
  it("still streams run events end-to-end (no SSE regression)", async () => {
    mockedGetSession.mockResolvedValue({
      id: "sse-1",
      userId: "u1",
      workspaceId: "w1",
      title: "existing title",
    } as never);
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handler.onEvent({ type: "message_update" } as AgentEvent);
      handler.onDone();
    });

    const res = await app.request("/api/v1/projects/p1/sessions/sse-1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": "u1",
        "x-workspace-id": "w1",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_update");
    expect(text).toContain("event: done");
    // The run finished: no confirmation channel may outlive it.
    expect(pendingDecisions.channelFor("sse-1")).toBeUndefined();
  });
});
