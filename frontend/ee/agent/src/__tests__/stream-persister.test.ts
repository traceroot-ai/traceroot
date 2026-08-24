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

    // drain the microtask queue so a (incorrectly) fire-and-forget second
    // insert would have started — deterministic, no wall-clock dependency
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(order).toEqual(["start:assistant"]);

    releaseFirst();
    await done;
    expect(order).toEqual(["start:assistant", "end:assistant", "start:tool_step", "end:tool_step"]);
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
