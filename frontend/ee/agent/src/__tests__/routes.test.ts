import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TurnAttribution } from "../session.js";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  createSession: vi.fn(),
  executionBelongsToProject: vi.fn(),
  updateSessionTitle: vi.fn(),
  appendMessage: vi.fn(),
  runAgent: vi.fn(),
}));

// index.ts starts the service on import — DB ping, price sync, listen. Stub
// those so the Hono app can be driven through app.request(). The capture
// policy (`@traceroot/core/capture-policy`) is a separate module id and stays
// real, so the persister below runs the actual policy.
vi.mock("@traceroot/core", () => ({
  prisma: { project: { count: async () => 0 } },
  syncStandardPrices: async () => {},
  calculateCost: async () => 0,
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));
vi.mock("@hono/node-server", () => ({ serve: () => {} }));
vi.mock("../session.js", () => ({
  createSession: mocks.createSession,
  getSession: mocks.getSession,
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionTitle: mocks.updateSessionTitle,
  executionBelongsToProject: mocks.executionBelongsToProject,
}));
vi.mock("../agent.js", () => ({
  getOrCreateAgent: async () => ({
    agent: {},
    sessionManager: { appendMessage: mocks.appendMessage },
  }),
  runAgent: mocks.runAgent,
  removeAgent: () => {},
  invalidateProviderCache: () => {},
}));
vi.mock("../executors/index.js", () => ({
  createExecutor: () => ({ destroy: async () => {} }),
}));
vi.mock("../tools/index.js", () => ({ createTools: () => [] }));
vi.mock("../prompts/system.js", () => ({ getSystemPrompt: () => "" }));

import { app } from "../index.js";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.createSession.mockImplementation(async (params: unknown) => ({
    id: "new",
    ...(params as object),
  }));
  mocks.appendMessage.mockResolvedValue({ id: "row" });
  mocks.updateSessionTitle.mockResolvedValue({});
});

const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-workspace-id": "w", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /projects/:projectId/sessions", () => {
  it.each([
    ["a number", 123],
    ["an object", { id: "e1" }],
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "  "],
  ])(
    "rejects %s as executionId with 400 instead of creating an unattributed session",
    async (_, executionId) => {
      const res = await json("/api/v1/projects/p1/sessions", { executionId });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "executionId must be a non-empty string" });
      expect(mocks.executionBelongsToProject).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
    },
  );

  it("rejects an execution that does not belong to the project", async () => {
    mocks.executionBelongsToProject.mockResolvedValue(false);
    const res = await json("/api/v1/projects/p1/sessions", { executionId: "e-from-p2" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "executionId does not belong to this project" });
    expect(mocks.executionBelongsToProject).toHaveBeenCalledWith(
      expect.anything(),
      "e-from-p2",
      "p1",
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("creates a system session bound to an execution of this project", async () => {
    mocks.executionBelongsToProject.mockResolvedValue(true);
    const res = await json("/api/v1/projects/p1/sessions", { executionId: "e1" });
    expect(res.status).toBe(201);
    expect(mocks.createSession).toHaveBeenCalledWith({
      projectId: "p1",
      workspaceId: "w",
      userId: undefined,
      title: undefined,
      executionId: "e1",
    });
  });

  it("creates a user session with no execution when none is named", async () => {
    const res = await json("/api/v1/projects/p1/sessions", { title: "t" }, { "x-user-id": "u1" });
    expect(res.status).toBe(201);
    expect(mocks.executionBelongsToProject).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledWith({
      projectId: "p1",
      workspaceId: "w",
      userId: "u1",
      title: "t",
      executionId: undefined,
    });
  });
});

const textDelta = (delta: string): AgentEvent =>
  ({
    type: "message_update",
    message: {} as never,
    assistantMessageEvent: { type: "text_delta", delta } as never,
  }) as AgentEvent;
const thinkingDelta = (delta: string): AgentEvent =>
  ({
    type: "message_update",
    message: {} as never,
    assistantMessageEvent: { type: "thinking_delta", delta } as never,
  }) as AgentEvent;
const toolStart = (id: string, toolName: string, args: Record<string, unknown>): AgentEvent => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName,
  args,
});
const toolEnd = (id: string, toolName: string, result: unknown): AgentEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName,
  result,
  isError: false,
});
const messageEnd: AgentEvent = {
  type: "message_end",
  message: {
    model: "m",
    provider: "p",
    usage: { input: 1, output: 2, cost: { total: 0.01 } },
  } as never,
};

/** Make runAgent replay `events` into the route's handler, then end the run. */
function drive(events: AgentEvent[], outcome: "done" | "error") {
  mocks.runAgent.mockImplementation(
    async (
      _agent: unknown,
      _message: string,
      handler: {
        onEvent: (e: AgentEvent) => void;
        onError: (e: Error) => Promise<void>;
        onDone: () => Promise<void>;
      },
    ) => {
      for (const e of events) handler.onEvent(e);
      if (outcome === "error") await handler.onError(new Error("boom"));
      else await handler.onDone();
    },
  );
}

async function postMessage(headers: Record<string, string> = {}) {
  const res = await json(
    "/api/v1/projects/p1/sessions/s1/messages",
    { message: "why?", model: "m" },
    headers,
  );
  expect(res.status).toBe(200);
  // The SSE body closes when the run has been persisted; reading it to the
  // end is what waits for that.
  await res.text();
  return mocks.appendMessage.mock.calls as Array<
    [string, string, TurnAttribution, Record<string, unknown> | undefined, unknown]
  >;
}

const systemSession = { id: "s1", userId: null, executionId: "e1", workspaceId: "w", title: "t" };
const userSession = { id: "s1", userId: "u1", executionId: null, workspaceId: "w", title: "t" };

describe("POST /projects/:projectId/sessions/:sessionId/messages — attribution", () => {
  it("attributes a system-session turn with no user to the execution", async () => {
    mocks.getSession.mockResolvedValue(systemSession);
    drive([textDelta("root cause")], "done");
    const [userRow] = await postMessage();
    expect(userRow.slice(0, 3)).toEqual([
      "user",
      "why?",
      { turnKind: "rca_execution", executionId: "e1", initiatorUserId: null },
    ]);
  });

  it("attributes a system-session turn with a user as a follow-up by that user", async () => {
    mocks.getSession.mockResolvedValue(systemSession);
    drive([textDelta("because")], "done");
    const [userRow] = await postMessage({ "x-user-id": "u9" });
    expect(userRow[2]).toEqual({
      turnKind: "rca_followup",
      executionId: "e1",
      initiatorUserId: "u9",
    });
  });

  it("attributes a user-session turn as chat by the caller", async () => {
    mocks.getSession.mockResolvedValue(userSession);
    drive([textDelta("hi")], "done");
    const [userRow] = await postMessage({ "x-user-id": "u1" });
    expect(userRow[2]).toEqual({ turnKind: "chat", initiatorUserId: "u1" });
  });

  it("stamps the same attribution on every row a turn produces", async () => {
    mocks.getSession.mockResolvedValue(systemSession);
    drive(
      [
        textDelta("Let me look."),
        toolStart("t1", "bash", { command: "ls" }),
        toolEnd("t1", "bash", "a b c"),
        thinkingDelta("hmm"),
        toolStart("t2", "download_traces", { traceId: "x" }),
        toolEnd("t2", "download_traces", { spans: [] }),
        messageEnd,
      ],
      "done",
    );
    const calls = await postMessage({ "x-user-id": "u9" });
    // user row, text segment, bash step, thinking-only segment, download step,
    // usage carrier (the run ended at a tool boundary with no trailing text)
    expect(calls.map(([role]) => role)).toEqual([
      "user",
      "assistant",
      "tool_step",
      "assistant",
      "tool_step",
      "assistant",
    ]);
    expect(calls[1][1]).toBe("Let me look.");
    expect(calls[2][3]).toMatchObject({ toolName: "bash", withheld: "not-allowlisted" });
    expect(calls[3][3]).toEqual({ thinking: "hmm" });
    expect(calls[4][3]).toMatchObject({ toolName: "download_traces", result: '{"spans":[]}' });
    expect(calls[5][1]).toBe("");
    expect(calls[5][4]).toMatchObject({ model: "m", inputTokens: 1, outputTokens: 2 });

    const attribution = { turnKind: "rca_followup", executionId: "e1", initiatorUserId: "u9" };
    for (const call of calls) expect(call[2]).toEqual(attribution);
  });

  it("stamps the attribution on the rows persisted when the run errors", async () => {
    mocks.getSession.mockResolvedValue(systemSession);
    drive(
      [
        textDelta("Checking."),
        toolStart("t1", "bash", { command: "ls" }),
        toolEnd("t1", "bash", "x"),
        messageEnd,
      ],
      "error",
    );
    const calls = await postMessage();
    expect(calls.map(([role]) => role)).toEqual(["user", "assistant", "tool_step", "assistant"]);
    const attribution = { turnKind: "rca_execution", executionId: "e1", initiatorUserId: null };
    for (const call of calls) expect(call[2]).toEqual(attribution);
  });

  it("rejects a turn on a session the caller cannot see", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await json("/api/v1/projects/p1/sessions/s1/messages", { message: "why?" });
    expect(res.status).toBe(404);
    expect(mocks.appendMessage).not.toHaveBeenCalled();
  });
});
