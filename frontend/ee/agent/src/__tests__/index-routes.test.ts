import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { app } from "../index.js";
import { pendingDecisions, SESSION_DELETED_SKIP_REASON } from "../pending-decisions.js";
import { deleteSession, getSession } from "../session.js";
import { getOrCreateAgent, removeAgent, runAgent, type AgentEventHandler } from "../agent.js";
import { createExecutor } from "../executors/index.js";
import { clearSessionDeleted, isSessionDeleted } from "../executors/deleted-session-fence.js";
import { waitForRunToSettle } from "../run-stream.js";
import { createTools } from "../tools/index.js";
import { createWritePolicyHook } from "../tools/write-policy.js";
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
// Real run-stream, with one seam: a test needs the settle-wait to time out
// without actually waiting the ten seconds the route allows it.
vi.mock("../run-stream.js", async () => {
  const actual = await vi.importActual<typeof import("../run-stream.js")>("../run-stream.js");
  return { ...actual, waitForRunToSettle: vi.fn(actual.waitForRunToSettle) };
});
vi.mock("../prompts/system.js", () => ({
  getSystemPrompt: vi.fn(() => "system prompt"),
}));

const mockedGetSession = vi.mocked(getSession);
const mockedDeleteSession = vi.mocked(deleteSession);
const mockedRunAgent = vi.mocked(runAgent);

const CONFIRM_ENTRY = {
  name: "create_detector",
  policy: { approvalClass: "confirm", minRole: "MEMBER", tenancy: "project" },
} as const;

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
  // No test may leave a parked promise behind: an undecided park holds a
  // timeout and a confirmation channel open into the next test.
  for (const sessionId of ["del-1", "del-2", "mount-1", "sse-1"]) {
    pendingDecisions.releaseSession(sessionId, "test cleanup");
  }
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
  });

  it("authorizes before tearing down the session's executor and agent", async () => {
    // A project member holding another user's session id must not be able
    // to destroy that session's sandbox or evict its agent by way of a 404.
    mockedGetSession.mockResolvedValue({
      id: "del-3",
      userId: "u1",
      projectId: "p1",
      workspaceId: "w1",
      title: "t",
    } as never);
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handler.onDone();
    });
    const run = await app.request("/api/v1/projects/p1/sessions/del-3/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "u1" },
      body: JSON.stringify({ message: "hello" }),
    });
    await run.text();
    const executor = vi.mocked(createExecutor).mock.results[0].value as { destroy: Mock };

    mockedDeleteSession.mockResolvedValue(null as never);
    const intruder = await app.request("/api/v1/projects/p1/sessions/del-3", {
      method: "DELETE",
      headers: { "x-user-id": "intruder" },
    });
    expect(intruder.status).toBe(404);
    expect(executor.destroy).not.toHaveBeenCalled();
    expect(vi.mocked(removeAgent)).not.toHaveBeenCalled();

    mockedDeleteSession.mockResolvedValue({ id: "del-3" } as never);
    const owner = await app.request("/api/v1/projects/p1/sessions/del-3", {
      method: "DELETE",
      headers: { "x-user-id": "u1" },
    });
    expect(owner.status).toBe(200);
    expect(executor.destroy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(removeAgent)).toHaveBeenCalledWith("del-3");
  });

  it("destroys the executor only after a parked run settles, and revives no sandbox", async () => {
    // Deleting a session with a parked run releases that decision, which
    // resumes the run in a microtask. Destroying the executor before the run
    // settles lets the resumed run's next sandbox tool call re-init a
    // container this service no longer tracks — leaked until the process dies.
    mockedGetSession.mockResolvedValue({
      id: "del-4",
      userId: "u1",
      projectId: "p1",
      workspaceId: "w1",
      title: "t",
    } as never);

    const order: string[] = [];
    // The executor the session's tools actually hold — the fenced one, not
    // the raw container handle.
    const toolExecutor = () =>
      vi.mocked(createTools).mock.calls[0][0].executor as { init: () => Promise<void> };
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      // The run parks a confirm-class call and waits on the user's answer.
      const { outcome } = pendingDecisions.park({
        sessionId: "del-4",
        toolCallId: "tc-4",
        toolName: "create_detector",
        args: {},
      });
      await outcome;
      // Resumed: the next sandbox tool call would bring a container back.
      order.push("run resumed");
      try {
        await toolExecutor().init();
        order.push("sandbox re-inited");
      } catch {
        order.push("sandbox refused");
      }
      order.push("run settled");
      handler.onDone();
    });

    const run = app.request("/api/v1/projects/p1/sessions/del-4/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "u1" },
      body: JSON.stringify({ message: "add a detector" }),
    });
    // Let the route reach runAgent and park before the delete lands.
    const response = await run;
    await vi.waitFor(() => expect(pendingDecisions.pendingCount("del-4")).toBe(1));
    const container = vi.mocked(createExecutor).mock.results[0].value as {
      init: Mock;
      destroy: Mock;
    };
    container.destroy.mockImplementation(async () => {
      order.push("executor destroyed");
    });

    mockedDeleteSession.mockResolvedValue({ id: "del-4" } as never);
    const del = await app.request("/api/v1/projects/p1/sessions/del-4", {
      method: "DELETE",
      headers: { "x-user-id": "u1" },
    });
    await response.text();

    expect(del.status).toBe(200);
    // The teardown waits for the run; the resumed run gets no new sandbox.
    expect(order).toEqual(["run resumed", "sandbox refused", "run settled", "executor destroyed"]);
    expect(container.destroy).toHaveBeenCalledTimes(1);
    // The fence refused before the container handle was ever touched.
    expect(container.init).not.toHaveBeenCalled();
    expect(vi.mocked(createExecutor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(removeAgent)).toHaveBeenCalledWith("del-4");
  });

  it("keeps the deleted-session fence up when the run outlives the settle wait", async () => {
    // The wait is bounded, so a run that will not settle cannot hang the
    // DELETE. But the run is still live when the wait gives up: dropping the
    // fence then would let its next sandbox call build a container nothing
    // tracks — exactly the leak the fence exists to prevent.
    mockedGetSession.mockResolvedValue({
      id: "del-6",
      userId: "u1",
      projectId: "p1",
      workspaceId: "w1",
      title: "t",
    } as never);
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handler.onDone();
    });
    await (
      await app.request("/api/v1/projects/p1/sessions/del-6/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "u1" },
        body: JSON.stringify({ message: "hello" }),
      })
    ).text();

    vi.mocked(waitForRunToSettle).mockResolvedValueOnce(false);
    mockedDeleteSession.mockResolvedValue({ id: "del-6" } as never);
    const del = await app.request("/api/v1/projects/p1/sessions/del-6", {
      method: "DELETE",
      headers: { "x-user-id": "u1" },
    });

    expect(del.status).toBe(200);
    expect(isSessionDeleted("del-6")).toBe(true);

    // Cleanup: in production releaseRun drops this mark when the run settles.
    clearSessionDeleted("del-6");
  });

  it("clears the deleted-session fence and the executor entry even when the teardown throws", async () => {
    // The fence must not outlive the request that raised it. A mark left
    // behind refuses a sandbox to every later run in this process, and the
    // executor map must not keep handing out a handle whose destroy failed.
    mockedGetSession.mockResolvedValue({
      id: "del-5",
      userId: "u1",
      projectId: "p1",
      workspaceId: "w1",
      title: "t",
    } as never);
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handler.onDone();
    });
    const run = () =>
      app.request("/api/v1/projects/p1/sessions/del-5/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "u1" },
        body: JSON.stringify({ message: "hello" }),
      });
    await (await run()).text();
    const container = vi.mocked(createExecutor).mock.results[0].value as { destroy: Mock };
    container.destroy.mockRejectedValue(new Error("sandbox host unreachable"));

    mockedDeleteSession.mockResolvedValue({ id: "del-5" } as never);
    const del = await app.request("/api/v1/projects/p1/sessions/del-5", {
      method: "DELETE",
      headers: { "x-user-id": "u1" },
    });

    // The caller still learns the teardown failed — the cleanup is not a
    // swallow — but the process is left in a usable state.
    expect(del.status).toBe(500);
    expect(isSessionDeleted("del-5")).toBe(false);

    // The next run for this id builds a fresh executor (the dead one was
    // untracked before the destroy) and the cleared fence lets it init.
    await (await run()).text();
    expect(vi.mocked(createExecutor)).toHaveBeenCalledTimes(2);
    const fenced = vi.mocked(createTools).mock.calls[1][0].executor as {
      init: () => Promise<void>;
    };
    await expect(fenced.init()).resolves.toBeUndefined();
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

describe("messages route attendedness", () => {
  it("treats a signed-in user continuing a system (RCA) session as attended", async () => {
    // The session row's owner is null for RCA sessions the detector processor
    // creates, but the REQUEST carries a user who can answer confirmation
    // cards — a confirm-class write must park for them, not execute silently.
    mockedGetSession.mockResolvedValue({
      id: "rca-1",
      userId: null,
      projectId: "p1",
      workspaceId: "w1",
      title: "RCA: checkout timeout",
    } as never);
    const hook = createWritePolicyHook([CONFIRM_ENTRY], { sessionId: "rca-1" });
    let channelUserId: string | undefined;
    let parkedCount: number | undefined;
    let hookResult: Promise<unknown> | undefined;
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      channelUserId = pendingDecisions.channelFor("rca-1")?.userId;
      hookResult = hook({
        toolCall: { type: "toolCall", id: "tc-1", name: "create_detector", arguments: {} },
        args: {},
      } as never);
      // Parked: nothing settles until the user decides.
      await new Promise((resolve) => setImmediate(resolve));
      parkedCount = pendingDecisions.pendingCount("rca-1");
      pendingDecisions.releaseSession("rca-1", "test cleanup");
      await hookResult;
      handler.onDone();
    });

    const res = await app.request("/api/v1/projects/p1/sessions/rca-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "u1" },
      body: JSON.stringify({ message: "create a detector for this" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(channelUserId).toBe("u1");
    expect(parkedCount).toBe(1);
    expect(text).toContain("event: confirmation_pending");
    await expect(hookResult).resolves.toEqual({ block: true, reason: "test cleanup" });
  });
});

describe("messages route concurrency", () => {
  it("rejects a second prompt while a run is in flight without disturbing the first run", async () => {
    // A rival prompt on a parked session used to persist its user row,
    // register a last-wins channel, fail in pi's "already processing"
    // check, and — on its error path — release the FIRST run's healthy
    // proposal before unregistering the only channel.
    mockedGetSession.mockResolvedValue({
      id: "busy-1",
      userId: "u1",
      projectId: "p1",
      workspaceId: "w1",
      title: "t",
    } as never);
    let finishFirstRun!: () => void;
    const firstRunGate = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      park("busy-1");
      await firstRunGate;
      pendingDecisions.releaseSession("busy-1", "test cleanup");
      handler.onDone();
    });
    const post = () =>
      app.request("/api/v1/projects/p1/sessions/busy-1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "u1" },
        body: JSON.stringify({ message: "hello" }),
      });

    const first = await post();
    expect(first.status).toBe(200);
    const firstChannel = pendingDecisions.channelFor("busy-1");
    expect(firstChannel).toBeDefined();

    const second = await post();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: expect.stringContaining("in progress") });
    // Nothing of the second request touched the session: no agent lookup
    // (so no user row), and the first run's proposal and channel are intact.
    expect(vi.mocked(getOrCreateAgent)).toHaveBeenCalledTimes(1);
    expect(pendingDecisions.pendingCount("busy-1")).toBe(1);
    expect(pendingDecisions.channelFor("busy-1")).toBe(firstChannel);

    finishFirstRun();
    expect(await first.text()).toContain("event: done");
    // The claim is released with the run, so the session accepts prompts again.
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handler.onDone();
    });
    const third = await post();
    expect(third.status).toBe(200);
    await third.text();
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
