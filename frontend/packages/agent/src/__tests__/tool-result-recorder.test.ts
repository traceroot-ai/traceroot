import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

import { createToolResultRecorder } from "../tool-result-recorder.js";
import type { ToolResultData } from "../session.js";

type TurnEndEvent = Extract<AgentEvent, { type: "turn_end" }>;

const turnEnd = (toolResults: TurnEndEvent["toolResults"]): AgentEvent => ({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [],
    api: "test" as never,
    provider: "test" as never,
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  },
  toolResults,
});

describe("createToolResultRecorder", () => {
  it("persists turn_end tool results with args captured from tool start events", async () => {
    const appendToolResult = vi.fn<(_: ToolResultData) => Promise<void>>().mockResolvedValue();
    const recorder = createToolResultRecorder({ appendToolResult });

    recorder.handleEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "download_traces",
      args: { traceIds: ["trace-1"] },
    });
    recorder.handleEvent(
      turnEnd([
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "download_traces",
          content: [{ type: "text", text: "downloaded" }],
          details: { path: "/workspace/traces/trace-1" },
          isError: false,
          timestamp: 1,
        },
      ]),
    );

    await recorder.flush();

    expect(appendToolResult).toHaveBeenCalledWith({
      toolCallId: "call-1",
      toolName: "download_traces",
      args: { traceIds: ["trace-1"] },
      result: {
        content: [{ type: "text", text: "downloaded" }],
        details: { path: "/workspace/traces/trace-1" },
      },
      isError: false,
    });
  });

  it("falls back to toolResult fields when a start event was not observed", async () => {
    const appendToolResult = vi.fn<(_: ToolResultData) => Promise<void>>().mockResolvedValue();
    const recorder = createToolResultRecorder({ appendToolResult });

    recorder.handleEvent(
      turnEnd([
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "bash",
          content: [{ type: "text", text: "boom" }],
          isError: true,
          timestamp: 1,
        },
      ]),
    );

    await recorder.flush();

    expect(appendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "call-2",
        toolName: "bash",
        args: {},
        isError: true,
      }),
    );
  });

  it("logs persistence failures and continues later tool result writes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const appendToolResult = vi
      .fn<(_: ToolResultData) => Promise<void>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);
    const recorder = createToolResultRecorder({ appendToolResult });

    recorder.handleEvent(
      turnEnd([
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "first" }],
          isError: false,
          timestamp: 1,
        },
      ]),
    );
    recorder.handleEvent(
      turnEnd([
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "read",
          content: [{ type: "text", text: "second" }],
          isError: false,
          timestamp: 2,
        },
      ]),
    );

    await recorder.flush();

    expect(errorSpy).toHaveBeenCalledWith(
      "[Agent] Failed to persist tool result call-1:",
      "db down",
    );
    expect(appendToolResult).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
