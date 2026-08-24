import { describe, expect, it } from "vitest";
import { mapDbMessages } from "./map-db-messages";

const base = { createTime: "2026-01-01T00:00:00Z" };

describe("mapDbMessages", () => {
  it("maps persisted tool_step rows into the bubble shape the live stream produces", () => {
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
          result: { spans: 3 },
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
      isError: false,
      status: "done",
    });
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

  it("keeps a usage carrier row when there is no earlier assistant bubble", () => {
    const msgs = mapDbMessages([
      { ...base, id: "u1", role: "user", content: "go" },
      { ...base, id: "a1", role: "assistant", content: "", inputTokens: 5, outputTokens: 1 },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].inputTokens).toBe(5);
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
