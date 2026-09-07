import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { StreamPersister } from "../stream-persister.js";
import type { TokenUsageData } from "../session.js";

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

const toolStart = (id: string, args: Record<string, unknown> = {}): AgentEvent => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: "get_traces",
  args,
});

const toolEnd = (id: string, result: unknown = "ok", isError = false): AgentEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "get_traces",
  result,
  isError,
});

const USAGE: TokenUsageData = {
  model: "test-model",
  provider: "test-provider",
  isByok: false,
  inputTokens: 10,
  outputTokens: 20,
  cost: 0.05,
};

type AppendCall = {
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  tokenUsage?: TokenUsageData;
};

function makePersister() {
  const calls: AppendCall[] = [];
  const append = vi.fn(
    async (
      role: string,
      content: string,
      metadata?: Record<string, unknown>,
      tokenUsage?: TokenUsageData,
    ) => {
      calls.push({ role, content, metadata, tokenUsage });
    },
  );
  return { persister: new StreamPersister(append), calls, append };
}

describe("StreamPersister", () => {
  it("persists a text-only run as a single assistant row carrying the usage", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(textDelta("Hello"));
    persister.onEvent(textDelta(" world"));
    await persister.finish(USAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: "assistant",
      content: "Hello world",
      tokenUsage: USAGE,
    });
  });

  it("flushes text segments at tool boundaries so interleaving survives", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(textDelta("Let me check."));
    persister.onEvent(toolStart("t1", { traceId: "abc" }));
    persister.onEvent(toolEnd("t1", { spans: 3 }));
    persister.onEvent(textDelta("Found it."));
    await persister.finish(USAGE);

    expect(calls.map((c) => c.role)).toEqual(["assistant", "tool_step", "assistant"]);
    expect(calls[0].content).toBe("Let me check.");
    expect(calls[0].tokenUsage).toBeUndefined();
    expect(calls[2].content).toBe("Found it.");
    // usage lands on the final segment only
    expect(calls[2].tokenUsage).toEqual(USAGE);
  });

  it("records tool args from start and result from end in metadata", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(toolStart("t1", { query: "errors" }));
    persister.onEvent(toolEnd("t1", { rows: [] }, true));
    await persister.finish();

    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe("tool_step");
    expect(calls[0].metadata).toEqual({
      toolCallId: "t1",
      toolName: "get_traces",
      args: { query: "errors" },
      result: { rows: [] },
      isError: true,
    });
  });

  it("keeps thinking out of content and stores it in metadata", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(thinkingDelta("hmm..."));
    persister.onEvent(textDelta("The answer."));
    await persister.finish();

    expect(calls).toHaveLength(1);
    expect(calls[0].content).toBe("The answer.");
    expect(calls[0].metadata).toEqual({ thinking: "hmm..." });
  });

  it("persists nothing for a run that produced neither output nor usage", async () => {
    const { persister, calls } = makePersister();
    await persister.finish();
    expect(calls).toHaveLength(0);
  });

  it("persists a usage-carrying row for a run that ends at a tool boundary", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(textDelta("Checking."));
    persister.onEvent(toolStart("t1"));
    persister.onEvent(toolEnd("t1"));
    await persister.finish(USAGE);

    // no trailing text, but the run's usage must still land so it is billed
    expect(calls.map((c) => c.role)).toEqual(["assistant", "tool_step", "assistant"]);
    expect(calls[2]).toMatchObject({ content: "", tokenUsage: USAGE });
  });

  it("stores the cumulative session total in the final segment's metadata", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(textDelta("Done."));
    await persister.finish({ ...USAGE, totalTokens: 1234 });

    expect(calls).toHaveLength(1);
    expect(calls[0].metadata).toEqual({ totalTokens: 1234 });
  });

  it("serializes DB writes: a later row is not inserted until the earlier one lands", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let call = 0;
    const append = vi.fn(async (role: string) => {
      call += 1;
      if (call === 1) {
        order.push(`start:${role}`);
        await gate;
        order.push(`end:${role}`);
      } else {
        order.push(`start:${role}`);
        order.push(`end:${role}`);
      }
    });
    const persister = new StreamPersister(append);

    persister.onEvent(textDelta("segment"));
    persister.onEvent(toolStart("t1"));
    persister.onEvent(toolEnd("t1"));
    const done = persister.finish();

    // drain the microtask queue so an (incorrectly) fire-and-forget second
    // insert would have started — deterministic, no wall-clock dependency
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(order).toEqual(["start:assistant"]);

    releaseFirst();
    await done;
    expect(order).toEqual(["start:assistant", "end:assistant", "start:tool_step", "end:tool_step"]);
  });

  it("persists parallel tool rows in start order even when they end out of order", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(toolStart("t1", { first: true }));
    persister.onEvent(toolStart("t2", { second: true }));
    // parallel execution: t2 completes before t1
    persister.onEvent(toolEnd("t2", "t2 result"));
    persister.onEvent(toolEnd("t1", "t1 result"));
    await persister.finish();

    expect(calls.map((c) => c.role)).toEqual(["tool_step", "tool_step"]);
    expect(calls.map((c) => c.metadata?.toolCallId)).toEqual(["t1", "t2"]);
    expect(calls[0].metadata).toMatchObject({ args: { first: true }, result: "t1 result" });
    expect(calls[1].metadata).toMatchObject({ args: { second: true }, result: "t2 result" });
  });

  it("still flushes completed tool rows in start order when an earlier tool never ends", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(toolStart("t1"));
    persister.onEvent(toolStart("t2"));
    persister.onEvent(toolStart("t3"));
    // the run dies while t1 is still executing; t3 then t2 completed
    persister.onEvent(toolEnd("t3"));
    persister.onEvent(toolEnd("t2"));
    await persister.finish();

    expect(calls.map((c) => c.metadata?.toolCallId)).toEqual(["t2", "t3"]);
  });

  it("persists a message_end error as a runError marker on the final segment", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(textDelta("partial answer"));
    persister.onEvent({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "boom" },
    } as unknown as AgentEvent);
    await persister.finish(USAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: "assistant",
      content: "partial answer",
      metadata: { runError: "boom" },
      tokenUsage: USAGE,
    });
  });

  it("persists a run-level error recorded via recordError even with no other output", async () => {
    const { persister, calls } = makePersister();
    persister.recordError("model exploded");
    await persister.finish();

    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe("assistant");
    expect(calls[0].content).toBe("");
    expect(calls[0].metadata).toEqual({ runError: "model exploded" });
  });

  it("keeps the error marker but drops the usage of a run that consumed nothing", async () => {
    // A run that fails on its first provider request (bad key, 401/429)
    // reports a model with zero tokens; persisting that usage would meter a
    // run the user never got. The marker still lands so reload shows the
    // failure, but with no usage so metering ignores the row.
    const { persister, calls } = makePersister();
    persister.onEvent({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "401 invalid api key" },
    } as unknown as AgentEvent);
    await persister.finish({ ...USAGE, inputTokens: 0, outputTokens: 0, cost: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: "assistant",
      content: "",
      metadata: { runError: "401 invalid api key" },
    });
    expect(calls[0].tokenUsage).toBeUndefined();
  });

  it("persists nothing for a run that produced no output and consumed no tokens", async () => {
    const { persister, calls } = makePersister();
    await persister.finish({ ...USAGE, inputTokens: 0, outputTokens: 0, cost: 0 });
    expect(calls).toHaveLength(0);
  });

  it("keeps a run billable when it reported a cost but no tokens", async () => {
    // Cached-read-only turns and providers that price without reporting a
    // token split still cost money: a positive cost is consumption, and
    // dropping the usage would meter the run at nothing.
    const { persister, calls } = makePersister();
    const usage = { ...USAGE, inputTokens: 0, outputTokens: 0, cost: 0.004 };
    await persister.finish(usage);

    expect(calls).toHaveLength(1);
    expect(calls[0].tokenUsage).toEqual(usage);
  });

  it("keeps an errored run billable when it consumed tokens before failing", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(toolStart("t1"));
    persister.onEvent(toolEnd("t1"));
    persister.recordError("model exploded");
    await persister.finish(USAGE);

    expect(calls.map((c) => c.role)).toEqual(["tool_step", "assistant"]);
    expect(calls[1]).toMatchObject({ metadata: { runError: "model exploded" }, tokenUsage: USAGE });
  });

  it("keeps a zero-token run billable when it still produced text (provider omitted usage)", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(textDelta("An answer."));
    const usage = { ...USAGE, inputTokens: 0, outputTokens: 0, cost: 0 };
    await persister.finish(usage);

    expect(calls).toHaveLength(1);
    expect(calls[0].tokenUsage).toEqual(usage);
  });

  it("keeps the first recorded error when message_end and onError both report", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "specific API error" },
    } as unknown as AgentEvent);
    persister.recordError("run failed");
    await persister.finish();

    expect(calls[0].metadata).toEqual({ runError: "specific API error" });
  });

  it("does not attach runError to rows of a run that succeeded", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(textDelta("fine"));
    persister.onEvent({
      type: "message_end",
      message: { stopReason: "stop" },
    } as unknown as AgentEvent);
    await persister.finish(USAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0].metadata).toBeUndefined();
  });

  it("replaces oversized tool args and result values with a truncation marker", async () => {
    const big = "x".repeat(10 * 1024);
    const { persister, calls } = makePersister();
    persister.onEvent(toolStart("t1", { query: big, small: "kept" }));
    persister.onEvent(
      toolEnd("t1", {
        content: big,
        details: { resourceType: "dashboard", resourceId: "d1" },
      }),
    );
    await persister.finish();

    expect(calls).toHaveLength(1);
    const md = calls[0].metadata as {
      args: { query: unknown; small: unknown };
      result: { content: unknown; details: unknown };
    };
    // the oversized string is replaced by a detectable marker
    expect(md.args.query).toMatchObject({ truncated: true, bytes: expect.any(Number) });
    expect((md.args.query as { preview: string }).preview).toBe("x".repeat(256));
    expect((md.args.query as { bytes: number }).bytes).toBeGreaterThanOrEqual(10 * 1024);
    // sibling small values survive untouched
    expect(md.args.small).toBe("kept");
    // result: the large content is capped, the small structured details are not
    expect(md.result.content).toMatchObject({ truncated: true });
    expect(md.result.details).toEqual({ resourceType: "dashboard", resourceId: "d1" });
  });

  it("leaves small args and results exactly as captured (no marker under the cap)", async () => {
    const { persister, calls } = makePersister();
    persister.onEvent(toolStart("t1", { query: "errors" }));
    persister.onEvent(toolEnd("t1", { details: { resourceId: "d1" } }));
    await persister.finish();

    expect(calls[0].metadata).toMatchObject({
      args: { query: "errors" },
      result: { details: { resourceId: "d1" } },
    });
  });

  it("keeps persisting later rows when an earlier insert fails", async () => {
    const calls: string[] = [];
    let call = 0;
    const append = vi.fn(async (role: string) => {
      call += 1;
      if (call === 1) throw new Error("db down");
      calls.push(role);
    });
    const persister = new StreamPersister(append);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    persister.onEvent(textDelta("lost segment"));
    persister.onEvent(toolStart("t1"));
    persister.onEvent(toolEnd("t1"));
    await persister.finish();

    expect(calls).toEqual(["tool_step"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
