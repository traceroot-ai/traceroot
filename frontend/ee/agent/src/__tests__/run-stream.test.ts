import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { runAgent, type AgentEventHandler } from "../agent.js";
import {
  CLIENT_DISCONNECTED_SKIP_REASON,
  PARKED_HEARTBEAT_MS,
  PendingDecisions,
  RUN_ENDED_SKIP_REASON,
  RUN_ERROR_SKIP_REASON,
} from "../pending-decisions.js";
import { runAgentStream, type AgentRunStream } from "../run-stream.js";

vi.mock("../agent.js", () => ({
  runAgent: vi.fn(),
}));

const mockedRunAgent = vi.mocked(runAgent);

interface FakeStream extends AgentRunStream {
  events: Array<{ event?: string; data: string }>;
  raw: string[];
  triggerAbort: () => void;
}

function fakeStream(): FakeStream {
  const events: Array<{ event?: string; data: string }> = [];
  const raw: string[] = [];
  const abortCallbacks: Array<() => void | Promise<void>> = [];
  return {
    events,
    raw,
    writeSSE: async (message: { event?: string; data: string }) => {
      events.push(message);
    },
    write: async (input: string) => {
      raw.push(input);
    },
    onAbort: (cb: () => void | Promise<void>) => {
      abortCallbacks.push(cb);
    },
    triggerAbort: () => {
      for (const cb of abortCallbacks) void cb();
    },
  };
}

function options(sessionId: string, decisions: PendingDecisions) {
  return {
    agent: {} as never,
    message: "make a detector",
    sessionId,
    channelUserId: "u1",
    isByok: false,
    sessionManager: { appendMessage: vi.fn(async () => ({}) as never) },
    decisions,
  };
}

function park(decisions: PendingDecisions, sessionId: string) {
  return decisions.park({
    sessionId,
    toolCallId: "tc-1",
    toolName: "create_detector",
    args: {},
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runAgentStream", () => {
  it("forwards agent events and the done event over SSE (existing stream contract)", async () => {
    const decisions = new PendingDecisions();
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handler.onEvent({ type: "message_start" } as AgentEvent);
      handler.onEvent({ type: "message_update" } as AgentEvent);
      handler.onEvent({ type: "message_update" } as AgentEvent);
      handler.onEvent({
        type: "message_end",
        message: { model: "m1", stopReason: "error", errorMessage: "boom" },
      } as unknown as AgentEvent);
      handler.onDone();
    });

    const stream = fakeStream();
    await runAgentStream(stream, options("rs-1", decisions));

    expect(stream.events.map((e) => e.event)).toEqual([
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "done",
    ]);
  });

  it("registers an attended confirmation channel for the run and removes it after", async () => {
    const decisions = new PendingDecisions();
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      const channel = decisions.channelFor("rs-2");
      expect(channel?.userId).toBe("u1");
      channel?.emit({
        type: "confirmation_pending",
        decisionId: "d1",
        toolCallId: "tc-1",
        toolName: "create_detector",
        args: { a: 1 },
      });
      handler.onDone();
    });

    const stream = fakeStream();
    await runAgentStream(stream, options("rs-2", decisions));

    expect(decisions.channelFor("rs-2")).toBeUndefined();
    const pendingEvent = stream.events.find((e) => e.event === "confirmation_pending");
    expect(pendingEvent).toBeDefined();
    expect(JSON.parse(pendingEvent!.data)).toEqual({
      type: "confirmation_pending",
      decisionId: "d1",
      toolCallId: "tc-1",
      toolName: "create_detector",
      args: { a: 1 },
    });
  });

  it("release path: a run error resolves parked decisions as skip", async () => {
    const decisions = new PendingDecisions();
    let outcome: Promise<unknown> | undefined;
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      outcome = park(decisions, "rs-3").outcome;
      handler.onError(new Error("model exploded"));
    });

    const stream = fakeStream();
    const opts = options("rs-3", decisions);
    await runAgentStream(stream, opts);

    await expect(outcome).resolves.toEqual({ action: "skip", reason: RUN_ERROR_SKIP_REASON });
    expect(decisions.pendingCount()).toBe(0);
    expect(stream.events.some((e) => e.event === "error")).toBe(true);
    // the failure is durable: the persisted final segment carries the error
    expect(opts.sessionManager.appendMessage).toHaveBeenCalledWith(
      "assistant",
      "",
      expect.objectContaining({ runError: "model exploded" }),
      undefined,
    );
  });

  it("release path: run completion resolves decisions still parked somehow", async () => {
    const decisions = new PendingDecisions();
    let outcome: Promise<unknown> | undefined;
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      outcome = park(decisions, "rs-4").outcome;
      handler.onDone();
    });

    await runAgentStream(fakeStream(), options("rs-4", decisions));

    await expect(outcome).resolves.toEqual({ action: "skip", reason: RUN_ENDED_SKIP_REASON });
    expect(decisions.pendingCount()).toBe(0);
  });

  it("release path: a client disconnect (stream abort) resolves parked decisions as skip", async () => {
    const decisions = new PendingDecisions();
    let handlerRef: AgentEventHandler | undefined;
    let outcome: Promise<unknown> | undefined;
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handlerRef = handler;
      outcome = park(decisions, "rs-5").outcome;
    });

    const stream = fakeStream();
    const running = runAgentStream(stream, options("rs-5", decisions));

    stream.triggerAbort();
    await expect(outcome).resolves.toEqual({
      action: "skip",
      reason: CLIENT_DISCONNECTED_SKIP_REASON,
    });
    expect(decisions.pendingCount()).toBe(0);

    // The unblocked turn runs to completion and the stream promise settles.
    handlerRef!.onDone();
    await running;
  });

  it("sends heartbeat comments through the stream while a decision is parked", async () => {
    vi.useFakeTimers();
    const decisions = new PendingDecisions();
    let handlerRef: AgentEventHandler | undefined;
    let decisionId: string | undefined;
    mockedRunAgent.mockImplementation(async (_agent, _msg, handler: AgentEventHandler) => {
      handlerRef = handler;
      decisionId = park(decisions, "rs-6").decisionId;
    });

    const stream = fakeStream();
    const running = runAgentStream(stream, options("rs-6", decisions));

    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 2);
    expect(stream.raw.filter((line) => line.startsWith(":")).length).toBe(2);

    decisions.decide(decisionId!, "rs-6", { action: "create" });
    handlerRef!.onDone();
    await running;
  });
});
