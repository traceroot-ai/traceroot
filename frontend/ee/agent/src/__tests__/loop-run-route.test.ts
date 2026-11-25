import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { AUTH } from "./internal-auth-support.js";

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  findSignals: vi.fn(),
  getSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  getOrCreateAgent: vi.fn(),
  runAgent: vi.fn(),
  removeAgent: vi.fn(),
  appendMessage: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    loopRun: { findUnique: mocks.findRun },
    signal: { findMany: mocks.findSignals },
  },
  syncStandardPrices: vi.fn(async () => {}),
  calculateCost: vi.fn(async () => 0),
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));
vi.mock("../session.js", () => ({
  createSession: vi.fn(),
  getSession: mocks.getSession,
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionTitle: mocks.updateSessionTitle,
  executionBelongsToProject: vi.fn(),
  projectWorkspaceId: vi.fn(),
  stampTraceStatus: vi.fn(async () => {}),
}));
vi.mock("../agent.js", () => ({
  getOrCreateAgent: mocks.getOrCreateAgent,
  runAgent: mocks.runAgent,
  removeAgent: mocks.removeAgent,
  abortSessionRun: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));
vi.mock("../executors/index.js", () => ({ createExecutor: vi.fn() }));
vi.mock("../tools/index.js", () => ({ createTools: vi.fn(() => []) }));
vi.mock("../prompts/system.js", () => ({ getSystemPrompt: vi.fn(() => "") }));

import { app } from "../index.js";
import type { AgentEventHandler, AgentRunnerConfig } from "../agent.js";
import { TIMED_OUT_ERROR } from "../loop-run-route.js";

const URL_ = "/api/v1/projects/p1/loop-runs/run-1";
const SYSTEM = { ...AUTH, "content-type": "application/json", "x-agent-system-call": "1" };

const RUN = {
  id: "run-1",
  projectId: "p1",
  loopId: "loop-1",
  seq: 7,
  trigger: "manual",
  status: "running",
  sessionId: "sess-1",
  loop: {
    name: "Errors",
    detectorId: "det-1",
    instructions: "Look for timeouts.",
    lookbackHours: 24,
    dryRun: true,
  },
};

let agent: {
  abort: ReturnType<typeof vi.fn>;
  state: { model: { id: string; provider: string } };
};
let config: AgentRunnerConfig | undefined;

function post(body: Record<string, unknown>, headers: Record<string, string> = SYSTEM) {
  return app.request(URL_, { method: "POST", headers, body: JSON.stringify(body) });
}

const BODY = { sessionId: "sess-1", deadlineMs: 60_000, model: "m1", source: "byok" };

function tool(name: string): AgentTool<any> {
  return config!.tools.find((t) => t.name === name)!;
}

/** Call one of the run's tools the way the agent would (the budget applies). */
function call(name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult<unknown>> {
  return tool(name).execute("tc", args);
}

const textOf = (result: AgentToolResult<unknown>) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/** The model's reply that closes the turn, priced as the provider reported it. */
function modelEnd(handler: AgentEventHandler, extra: Record<string, unknown> = {}) {
  handler.onEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      model: "m1",
      provider: "p",
      usage: { input: 10, output: 5, cost: { total: 0.0123 } },
      ...extra,
    },
  } as unknown as Parameters<AgentEventHandler["onEvent"]>[0]);
}

/** The turn: `body` runs inside the agent, the model's reply lands, then the run completes. */
function runs(body: () => Promise<void> | void) {
  mocks.runAgent.mockImplementation(
    async (_agent: unknown, _message: string, handler: AgentEventHandler) => {
      await body();
      modelEnd(handler);
      handler.onDone();
    },
  );
}

beforeEach(() => {
  agent = { abort: vi.fn(), state: { model: { id: "m1", provider: "openai" } } };
  config = undefined;
  mocks.findRun.mockResolvedValue(RUN);
  mocks.findSignals.mockResolvedValue([
    {
      id: "sig-1",
      groupKey: "loop:known-timeouts",
      title: "Known timeouts",
      status: "open",
      mergedIntoId: null,
      statusEvents: [],
    },
    {
      id: "sig-2",
      groupKey: "loop:known-timeouts",
      title: "Older copy",
      status: "open",
      mergedIntoId: null,
      statusEvents: [],
    },
    {
      id: "sig-3",
      groupKey: "loop:",
      title: "No key",
      status: "open",
      mergedIntoId: null,
      statusEvents: [],
    },
  ]);
  mocks.getSession.mockResolvedValue({
    id: "sess-1",
    userId: null,
    projectId: "p1",
    workspaceId: "w1",
    title: null,
    messages: [],
  });
  mocks.appendMessage.mockResolvedValue({ id: "msg-1", createTime: new Date() });
  mocks.getOrCreateAgent.mockImplementation(async (c: AgentRunnerConfig) => {
    config = c;
    return { agent, sessionManager: { appendMessage: mocks.appendMessage } };
  });
  vi.stubEnv("AGENT_SELF_TRACE", "0");
  // The trace and signal reads reach their backends over fetch: answer empty.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("POST loop-runs/:runId — refusals", () => {
  it("404s a missing run", async () => {
    mocks.findRun.mockResolvedValue(null);
    const res = await post(BODY);
    expect(res.status).toBe(404);
    expect(mocks.getOrCreateAgent).not.toHaveBeenCalled();
  });

  it("404s a run of another project", async () => {
    mocks.findRun.mockResolvedValue({ ...RUN, projectId: "p2" });
    expect((await post(BODY)).status).toBe(404);
    expect(mocks.getOrCreateAgent).not.toHaveBeenCalled();
  });

  it.each(["pending", "succeeded", "failed", "timed_out"])("409s a run that is %s", async (s) => {
    mocks.findRun.mockResolvedValue({ ...RUN, status: s });
    expect((await post(BODY)).status).toBe(409);
    expect(mocks.getOrCreateAgent).not.toHaveBeenCalled();
  });

  it("404s a session that is not a system session of the project", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await post(BODY)).status).toBe(404);
    expect(mocks.getSession).toHaveBeenCalledWith("sess-1", "", "p1");
  });

  it.each([
    [{ deadlineMs: 1000 }],
    [{ sessionId: "", deadlineMs: 1000 }],
    [{ sessionId: "sess-1" }],
    [{ sessionId: "sess-1", deadlineMs: -1 }],
    [{ sessionId: "sess-1", deadlineMs: 1000, source: "other" }],
    [{ sessionId: "other", deadlineMs: 1000 }],
    [{ sessionId: "sess-1", deadlineMs: 1000, model: 5 }],
    [{ sessionId: "sess-1", deadlineMs: 1000, providerName: {} }],
  ])("400s an invalid request %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.getOrCreateAgent).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON, or not an object", async () => {
    const res = await app.request(URL_, { method: "POST", headers: SYSTEM, body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
    expect((await app.request(URL_, { method: "POST", headers: SYSTEM, body: "[]" })).status).toBe(
      400,
    );
    expect(mocks.findRun).not.toHaveBeenCalled();
  });

  it("409s a second call for a session whose run is still going", async () => {
    let second: Response | undefined;
    runs(async () => {
      second = await post(BODY);
    });
    expect((await post(BODY)).status).toBe(200);
    expect(second?.status).toBe(409);
    expect(await second?.json()).toEqual({
      error: "a run is already in progress for this session",
    });
    expect(mocks.getOrCreateAgent).toHaveBeenCalledTimes(1);
  });

  it("400s a call that is not the system's", async () => {
    const res = await post(BODY, {
      ...AUTH,
      "content-type": "application/json",
      "x-user-id": "u1",
    });
    expect(res.status).toBe(400);
  });

  it("is behind the internal credential", async () => {
    const res = await post(BODY, {
      "content-type": "application/json",
      "x-agent-system-call": "1",
    });
    expect(res.status).toBe(403);
    expect(mocks.findRun).not.toHaveBeenCalled();
  });
});

describe("POST loop-runs/:runId — the turn", () => {
  it("runs one loop_execution turn and answers with the submitted summary", async () => {
    runs(async () => {
      await call("list_traces");
      await call("get_trace", { trace_id: "t1" });
      await call("loop_submit_summary", { summary: "Checked 12 traces." });
    });
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "submitted",
      summary: "Checked 12 traces.",
      tracesRead: 1,
      toolCalls: 3,
      costUsd: 0.0123,
      error: null,
      modelUsed: { model: "m1", provider: "openai", source: "byok" },
      findings: [],
    });
    // The kickoff row and every row the persister writes carry loop_execution.
    expect(mocks.appendMessage).toHaveBeenCalledWith("user", expect.any(String), {
      turnKind: "loop_execution",
    });
    for (const call of mocks.appendMessage.mock.calls) {
      expect(call[2]).toEqual({ turnKind: "loop_execution" });
    }
    // Model choice passes through unchanged; the agent gets the loop tools and prompt.
    expect(config).toMatchObject({
      sessionId: "sess-1",
      projectId: "p1",
      workspaceId: "w1",
      userId: "",
      model: "m1",
      source: "byok",
    });
    expect(config!.tools.map((t) => t.name)).toContain("loop_submit_summary");
    expect(config!.tools.map((t) => t.name)).not.toContain("run_sql");
    expect(config!.systemPrompt).toContain("Look for timeouts.");
    expect(config!.systemPrompt).toContain("Run: #7 of this loop, started by hand (Run now)");
    // The worker titles the session when it creates it.
    expect(mocks.updateSessionTitle).not.toHaveBeenCalled();
    expect(mocks.removeAgent).toHaveBeenCalledWith("sess-1");
  });

  it("answers no_summary, and no cost, when the turn ends without a summary or a model reply", async () => {
    mocks.runAgent.mockImplementation(async (_a: unknown, _m: string, handler: AgentEventHandler) =>
      handler.onDone(),
    );
    const body = await (await post(BODY)).json();
    expect(body).toEqual({
      status: "no_summary",
      summary: null,
      tracesRead: 0,
      toolCalls: 0,
      costUsd: null,
      error: null,
      modelUsed: { model: "m1", provider: "openai", source: "byok" },
      findings: [],
    });
  });

  it("tells the agent a scheduled run was started by its schedule", async () => {
    mocks.findRun.mockResolvedValue({ ...RUN, trigger: "schedule" });
    runs(() => call("loop_submit_summary", { summary: "Nothing new." }).then(() => undefined));
    expect((await post(BODY)).status).toBe(200);
    expect(config!.systemPrompt).toContain("Run: #7 of this loop, started by its schedule");
  });

  it("answers with the agent service's default model when the worker sent none", async () => {
    agent.state.model = { id: "claude-opus-4-8", provider: "anthropic" };
    runs(() => undefined);
    const body = await (await post({ sessionId: "sess-1", deadlineMs: 60_000 })).json();
    expect(config).toMatchObject({ model: undefined, source: undefined });
    expect(body.modelUsed).toEqual({
      model: "claude-opus-4-8",
      provider: "anthropic",
      source: "system",
    });
  });

  it("answers a BYOK model's saved provider label as its provider", async () => {
    runs(() => undefined);
    const body = await (await post({ ...BODY, providerName: "my-openai" })).json();
    expect(body.modelUsed).toEqual({ model: "m1", provider: "my-openai", source: "byok" });
  });

  it("answers with the run's findings, and offers the loop's existing keys", async () => {
    mocks.findRun.mockResolvedValue({ ...RUN, loop: { ...RUN.loop, dryRun: false } });
    // get_session reads both of the session's traces.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ traces: [{ trace_id: "t1" }, { trace_id: "t2" }] })),
      ),
    );
    runs(async () => {
      await call("get_session", { session_id: "s1" });
      await call("loop_record_finding", {
        key: "known-timeouts",
        title: "Timeouts",
        covers: "Calls that time out.",
        summary: "2 of 10 traces.",
        traceIds: ["t1", "t2"],
      });
      await call("loop_submit_summary", { summary: "One known problem." });
    });
    const body = await (await post(BODY)).json();
    vi.unstubAllGlobals();
    expect(body.findings).toEqual([
      {
        key: "known-timeouts",
        title: "Timeouts",
        covers: "Calls that time out.",
        summary: "2 of 10 traces.",
        traceIds: ["t1", "t2"],
      },
    ]);
    expect(mocks.findSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p1", detectorId: "det-1", groupKey: { startsWith: "loop:" } },
      }),
    );
    expect(config!.systemPrompt).toContain("This loop's signals (1)");
    expect(config!.systemPrompt).toContain('- known-timeouts · "Known timeouts" · open\n');
  });

  it("gives the run each signal's title, status and the reason people gave for it", async () => {
    mocks.findSignals.mockResolvedValue([
      {
        id: "sig-1",
        groupKey: "loop:empty-answers",
        title: "Empty answers",
        status: "dismissed",
        mergedIntoId: null,
        statusEvents: [{ toStatus: "dismissed", reason: "expected_behavior", note: "On purpose." }],
      },
      {
        id: "sig-2",
        groupKey: "loop:slow-search",
        title: "Slow search",
        status: "open",
        mergedIntoId: null,
        // Resolved, then reopened by a new hit: the old reason no longer applies.
        statusEvents: [{ toStatus: "resolved", reason: "fixed_by_pr", note: null }],
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              signals: [{ id: "sig-2", status: "open", title: "Slow search", hitCount: 3 }],
            }),
          ),
      ),
    );
    let listed = "";
    runs(async () => {
      listed = textOf(await call("list_signals"));
    });
    await post(BODY);
    vi.unstubAllGlobals();
    expect(mocks.findSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          statusEvents: expect.objectContaining({
            where: { toStatus: { in: ["resolved", "dismissed"] } },
            take: 1,
          }),
        }),
      }),
    );
    expect(config!.systemPrompt).toContain(
      '- empty-answers · "Empty answers" · dismissed · reason: expected_behavior · ' +
        'note: "On purpose."',
    );
    expect(config!.systemPrompt).toContain('- slow-search · "Slow search" · open\n');
    expect(listed).toContain(
      "sig-2 | open | Slow search | detector | this loop's key slow-search |",
    );
  });

  it("holds new keys to the plan cap in the prompt, the tool and the record cap", async () => {
    mocks.findRun.mockResolvedValue({
      ...RUN,
      loop: { ...RUN.loop, dryRun: false },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ trace_id: "t1" }))),
    );
    const replies: string[] = [];
    let recordCalls = 0;
    runs(async () => {
      await call("get_trace", { trace_id: "t1" });
      for (const key of ["new-a", "new-b", "new-c"]) {
        const result = await call("loop_record_finding", {
          key,
          title: "t",
          covers: "c",
          summary: "s",
          traceIds: ["t1"],
        });
        replies.push(JSON.stringify(result.content));
      }
      recordCalls = replies.length;
      while (!textOf(await call("loop_record_finding")).startsWith("Not performed")) {
        recordCalls += 1;
      }
    });
    const body = await (await post(BODY)).json();
    vi.unstubAllGlobals();
    expect(config!.systemPrompt).toContain("New finding keys allowed this run: 2.");
    expect(replies[2]).toContain("already recorded 2 new keys");
    expect(body.findings.map((f: { key: string }) => f.key)).toEqual(["new-a", "new-b"]);
    // 3 per key it may record: 2 new plus the 1 existing.
    expect(recordCalls).toBe(9);
  });

  it("answers no findings on a dry run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ trace_id: "t1" }))),
    );
    let reply = "";
    runs(async () => {
      await call("get_trace", { trace_id: "t1" });
      const result = await call("loop_record_finding", {
        key: "x-y",
        title: "t",
        covers: "c",
        summary: "s",
        traceIds: ["t1"],
      });
      reply = JSON.stringify(result.content);
    });
    const body = await (await post(BODY)).json();
    vi.unstubAllGlobals();
    expect(reply).toContain("Dry run: this finding is not recorded");
    expect(body.findings).toEqual([]);
  });

  it("answers budget_exhausted when a cap stopped the run before a summary", async () => {
    runs(async () => {
      for (let i = 0; i < 80; i++) await call("list_traces");
      expect(textOf(await call("list_traces"))).toContain("then call loop_submit_summary");
    });
    const body = await (await post(BODY)).json();
    expect(body).toMatchObject({ status: "budget_exhausted", toolCalls: 80, summary: null });
  });

  it("stops the agent at 25 trace reads' worth of refusals", async () => {
    runs(async () => {
      for (let i = 0; i < 25; i++) await call("get_trace", { trace_id: `t${i}` });
      for (let i = 0; i < 5; i++) await call("get_session", { session_id: "s1" });
    });
    const body = await (await post(BODY)).json();
    expect(body).toMatchObject({ status: "budget_exhausted", tracesRead: 25 });
    expect(agent.abort).toHaveBeenCalled();
  });

  it("aborts the agent at the deadline and answers timed_out with any summary", async () => {
    runs(async () => {
      await call("loop_submit_summary", { summary: "partial" });
      // The turn hangs until the deadline aborts it.
      await new Promise<void>((resolve) => agent.abort.mockImplementation(() => resolve()));
    });
    const body = await (await post({ ...BODY, deadlineMs: 20 })).json();
    expect(agent.abort).toHaveBeenCalled();
    expect(body).toMatchObject({
      status: "timed_out",
      summary: "partial",
      error: TIMED_OUT_ERROR,
    });
  });

  it("stops the turn when the worker's request goes away", async () => {
    const worker = new AbortController();
    runs(async () => {
      const stopped = new Promise<void>((resolve) =>
        agent.abort.mockImplementation(() => resolve()),
      );
      worker.abort();
      // The turn hangs until the abort stops it.
      await stopped;
    });
    await app.request(URL_, {
      method: "POST",
      headers: SYSTEM,
      body: JSON.stringify(BODY),
      signal: worker.signal,
    });
    expect(agent.abort).toHaveBeenCalled();
    expect(mocks.removeAgent).toHaveBeenCalledWith("sess-1");
  });

  it("stops the turn when the worker went away while the agent was being built", async () => {
    const worker = new AbortController();
    mocks.getOrCreateAgent.mockImplementation(async (c: AgentRunnerConfig) => {
      config = c;
      worker.abort();
      return { agent, sessionManager: { appendMessage: mocks.appendMessage } };
    });
    runs(() => undefined);
    await app.request(URL_, {
      method: "POST",
      headers: SYSTEM,
      body: JSON.stringify(BODY),
      signal: worker.signal,
    });
    expect(agent.abort).toHaveBeenCalled();
  });

  it("answers error with the run's failure", async () => {
    mocks.runAgent.mockImplementation(
      async (_a: unknown, _m: string, handler: AgentEventHandler) => {
        handler.onError(new Error("provider unavailable"));
      },
    );
    const body = await (await post(BODY)).json();
    expect(body).toMatchObject({ status: "error", error: "provider unavailable" });
  });

  it("answers error when the model call itself ended in an error, with its cost", async () => {
    mocks.runAgent.mockImplementation(
      async (_a: unknown, _m: string, handler: AgentEventHandler) => {
        modelEnd(handler, { stopReason: "error", errorMessage: "rate limited" });
        handler.onDone();
      },
    );
    const body = await (await post(BODY)).json();
    expect(body).toMatchObject({ status: "error", error: "rate limited", costUsd: 0.0123 });
  });

  it("answers error (200) when the agent cannot be built", async () => {
    mocks.getOrCreateAgent.mockRejectedValue(new Error("BYOK provider not found"));
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "error",
      error: "BYOK provider not found",
      modelUsed: null,
    });
    // The claim was released: a second call can run.
    mocks.getOrCreateAgent.mockImplementation(async (c: AgentRunnerConfig) => {
      config = c;
      return { agent, sessionManager: { appendMessage: mocks.appendMessage } };
    });
    runs(() => undefined);
    expect((await (await post(BODY)).json()).status).toBe("no_summary");
  });

  it("never writes the run's status", async () => {
    runs(() => undefined);
    await post(BODY);
    expect(Object.keys((await import("@traceroot/core")).prisma.loopRun)).toEqual(["findUnique"]);
  });
});
