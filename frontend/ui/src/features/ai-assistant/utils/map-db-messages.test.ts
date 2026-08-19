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
