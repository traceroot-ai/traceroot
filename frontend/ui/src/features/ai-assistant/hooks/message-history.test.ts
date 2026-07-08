import { describe, expect, it } from "vitest";

import { mapPersistedMessage } from "./message-history";

describe("mapPersistedMessage", () => {
  it("maps persisted tool rows to tool_step messages", () => {
    const mapped = mapPersistedMessage({
      id: "msg-1",
      role: "tool",
      content: "fallback result",
      createTime: "2026-07-08T00:00:00.000Z",
      metadata: {
        toolCallId: "call-1",
        toolName: "download_traces",
        args: { traceIds: ["trace-1"] },
        resultSummary: "Downloaded to /workspace/traces/trace-1/",
        isError: false,
      },
    });

    expect(mapped).toEqual({
      id: "msg-1",
      role: "tool_step",
      content: "",
      timestamp: "2026-07-08T00:00:00.000Z",
      toolStep: {
        toolCallId: "call-1",
        toolName: "download_traces",
        args: { traceIds: ["trace-1"] },
        result: "Downloaded to /workspace/traces/trace-1/",
        isError: false,
        status: "done",
      },
    });
  });

  it("uses safe fallbacks for old or malformed tool metadata", () => {
    const mapped = mapPersistedMessage({
      id: "msg-2",
      role: "tool",
      content: "raw tool content",
      createTime: "2026-07-08T00:00:01.000Z",
      metadata: { isError: true, args: ["not", "an", "object"] },
    });

    expect(mapped.role).toBe("tool_step");
    expect(mapped.toolStep).toMatchObject({
      toolCallId: "msg-2",
      toolName: "unknown_tool",
      args: {},
      result: "raw tool content",
      isError: true,
      status: "error",
    });
  });

  it("preserves assistant usage fields from persisted rows", () => {
    const mapped = mapPersistedMessage({
      id: "msg-3",
      role: "assistant",
      content: "answer",
      createTime: "2026-07-08T00:00:02.000Z",
      inputTokens: 10,
      outputTokens: 20,
      cost: "0.0123",
    });

    expect(mapped).toMatchObject({
      id: "msg-3",
      role: "assistant",
      content: "answer",
      timestamp: "2026-07-08T00:00:02.000Z",
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.0123,
    });
  });
});
