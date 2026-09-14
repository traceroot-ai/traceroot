import { describe, expect, it } from "vitest";
import { mapDbMessages } from "./map-db-messages";

const base = { createTime: "2026-01-01T00:00:00Z" };

describe("mapDbMessages", () => {
  it("maps persisted tool_step rows into the bubble shape the live stream produces", () => {
    // The persister stores the result as JSON text; the live stream showed the
    // parsed value, and the reloaded bubble must render the same way.
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "row1",
        role: "tool_step",
        content: "",
        metadata: {
          toolCallId: "t1",
          toolName: "get_traces",
          args: { traceId: "abc" },
          result: '{"spans":3}',
          outputBytes: 11,
          isError: false,
        },
      },
    ]);
    expect(msg.role).toBe("tool_step");
    expect(msg.toolStep).toEqual({
      toolCallId: "t1",
      toolName: "get_traces",
      args: { traceId: "abc" },
      result: { spans: 3 },
      outputBytes: 11,
      isError: false,
      status: "done",
    });
  });

  it("keeps a truncated result as text — a cut JSON string is not valid JSON — and passes the flag through", () => {
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "row1",
        role: "tool_step",
        content: "",
        metadata: {
          toolCallId: "t1",
          toolName: "get_traces",
          args: {},
          result: '{"spans":[{"span_id":"a"},{"span_… [truncated]',
          truncated: true,
          outputBytes: 90_000,
        },
      },
    ]);
    expect(msg.toolStep?.result).toBe('{"spans":[{"span_id":"a"},{"span_… [truncated]');
    expect(msg.toolStep?.truncated).toBe(true);
    expect(msg.toolStep?.outputBytes).toBe(90_000);
  });

  it("keeps a plain-string result as the string it was", () => {
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "row1",
        role: "tool_step",
        content: "",
        metadata: { toolCallId: "t1", toolName: "bash", args: {}, result: "total 0\n" },
      },
    ]);
    expect(msg.toolStep?.result).toBe("total 0\n");
  });

  it("passes a withheld result's reason and size through, with no result", () => {
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "row1",
        role: "tool_step",
        content: "",
        metadata: {
          toolCallId: "t1",
          toolName: "bash",
          args: { command: "ls" },
          withheld: "not-allowlisted",
          outputBytes: 44,
          isError: false,
        },
      },
    ]);
    expect(msg.toolStep).toMatchObject({ withheld: "not-allowlisted", outputBytes: 44 });
    expect(msg.toolStep?.result).toBeUndefined();
  });

  it("marks a failed tool step with error status", () => {
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "row1",
        role: "tool_step",
        content: "",
        metadata: { toolCallId: "t1", toolName: "get_traces", args: {}, isError: true },
      },
    ]);
    expect(msg.toolStep?.status).toBe("error");
    expect(msg.toolStep?.isError).toBe(true);
  });

  it("tolerates a tool_step row with missing metadata", () => {
    const [msg] = mapDbMessages([
      { ...base, id: "row1", role: "tool_step", content: "", metadata: null },
    ]);
    expect(msg.toolStep).toEqual({
      toolCallId: "row1",
      toolName: "unknown",
      args: {},
      result: undefined,
      isError: undefined,
      status: "done",
    });
  });

  it("restores thinking from assistant metadata without touching content", () => {
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "a1",
        role: "assistant",
        content: "The answer.",
        metadata: { thinking: "hmm..." },
      },
    ]);
    expect(msg.content).toBe("The answer.");
    expect(msg.thinking).toBe("hmm...");
  });

  it("restores the token/cost footer fields from the persisted usage columns", () => {
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "a1",
        role: "assistant",
        content: "answer",
        inputTokens: 120,
        outputTokens: 45,
        cost: 0.0123,
      },
    ]);
    expect(msg.inputTokens).toBe(120);
    expect(msg.outputTokens).toBe(45);
    expect(msg.costUsd).toBe(0.0123);
  });

  it("leaves footer fields undefined for rows without usage (non-final segments)", () => {
    const [msg] = mapDbMessages([
      { ...base, id: "a1", role: "assistant", content: "segment", inputTokens: null, cost: null },
    ]);
    expect(msg.inputTokens).toBeUndefined();
    expect(msg.costUsd).toBeUndefined();
  });

  it("coerces a Decimal-serialized string cost into a number", () => {
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "a1",
        role: "assistant",
        content: "answer",
        inputTokens: 120,
        outputTokens: 45,
        cost: "0.012300",
      },
    ]);
    expect(msg.costUsd).toBe(0.0123);
  });

  it("restores the cumulative session total from assistant metadata", () => {
    const [msg] = mapDbMessages([
      {
        ...base,
        id: "a1",
        role: "assistant",
        content: "answer",
        inputTokens: 120,
        outputTokens: 45,
        metadata: { totalTokens: 999 },
      },
    ]);
    expect(msg.totalTokens).toBe(999);
  });

  it("folds a content-less usage carrier row into the previous assistant bubble", () => {
    const msgs = mapDbMessages([
      { ...base, id: "u1", role: "user", content: "check the trace" },
      { ...base, id: "a1", role: "assistant", content: "Checking." },
      {
        ...base,
        id: "t1",
        role: "tool_step",
        content: "",
        metadata: { toolCallId: "t1", toolName: "get_traces", args: {} },
      },
      {
        ...base,
        id: "a2",
        role: "assistant",
        content: "",
        inputTokens: 50,
        outputTokens: 10,
        cost: "0.005000",
      },
    ]);
    // no empty bubble — the usage lands on the last text bubble, like live
    expect(msgs.map((m) => m.id)).toEqual(["u1", "a1", "t1"]);
    const bubble = msgs[1];
    expect(bubble.inputTokens).toBe(50);
    expect(bubble.outputTokens).toBe(10);
    expect(bubble.costUsd).toBe(0.005);
  });

  it("never folds a carrier across a run boundary onto an earlier run's bubble", () => {
    const msgs = mapDbMessages([
      { ...base, id: "u1", role: "user", content: "first question" },
      {
        ...base,
        id: "a1",
        role: "assistant",
        content: "First answer.",
        inputTokens: 100,
        outputTokens: 40,
        cost: "0.010000",
      },
      { ...base, id: "u2", role: "user", content: "now check the trace" },
      {
        ...base,
        id: "t1",
        role: "tool_step",
        content: "",
        metadata: { toolCallId: "t1", toolName: "get_traces", args: {} },
      },
      { ...base, id: "a2", role: "assistant", content: "", inputTokens: 50, outputTokens: 10 },
    ]);
    // run 1's usage is untouched; run 2's carrier stays its own row
    expect(msgs.map((m) => m.id)).toEqual(["u1", "a1", "u2", "t1", "a2"]);
    expect(msgs[1].inputTokens).toBe(100);
    expect(msgs[1].costUsd).toBe(0.01);
    expect(msgs[4].inputTokens).toBe(50);
  });

  it("keeps a usage carrier row when there is no earlier assistant bubble", () => {
    const msgs = mapDbMessages([
      { ...base, id: "u1", role: "user", content: "go" },
      { ...base, id: "a1", role: "assistant", content: "", inputTokens: 5, outputTokens: 1 },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].inputTokens).toBe(5);
  });

  it("passes traceId/traceStatus on assistant rows and spanId on tool_step rows through", () => {
    const out = mapDbMessages([
      {
        id: "t1",
        role: "tool_step",
        content: "",
        createTime: "2026-01-01T00:00:00Z",
        metadata: { toolCallId: "c1", toolName: "bash", args: {}, spanId: "abcdef0123456789" },
      },
      {
        id: "a1",
        role: "assistant",
        content: "done",
        createTime: "2026-01-01T00:00:01Z",
        metadata: { traceId: "f".repeat(32), traceStatus: "available" },
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);
    expect(out[0].toolStep?.spanId).toBe("abcdef0123456789");
    expect(out[1]).toMatchObject({ traceId: "f".repeat(32), traceStatus: "available" });
  });

  it("maps plain user/assistant rows and preserves order", () => {
    const msgs = mapDbMessages([
      { ...base, id: "u1", role: "user", content: "hi" },
      { ...base, id: "a1", role: "assistant", content: "hello" },
    ]);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    expect(msgs[0].timestamp).toBe("2026-01-01T00:00:00Z");
  });
});
