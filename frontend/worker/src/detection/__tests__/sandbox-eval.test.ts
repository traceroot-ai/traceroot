import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

// Mock Anthropic before importing the module under test
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
  };
});

// Mock @traceroot/core so tests don't need a real DB
vi.mock("@traceroot/core", () => ({
  resolveWorkspaceApiKey: vi.fn().mockResolvedValue("test-api-key"),
}));

import { runDetectionForTrace } from "../sandbox-eval";

const DETECTOR = {
  id: "det-1",
  name: "error detector",
  prompt: "Detect tool errors",
  outputSchema: [{ name: "category", type: "string" }],
};

describe("runDetectionForTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns identified=true when LLM calls submit_result with identified=true", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_result",
          input: {
            identified: true,
            summary: "Tool errored 3 times",
            data: { category: "tool_error" },
          },
        },
      ],
      stop_reason: "tool_use",
    });

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: '{"span_id":"1","status":"ERROR"}',
      detector: DETECTOR,
      workspaceId: "",
    });

    expect(result.identified).toBe(true);
    expect(result.summary).toBe("Tool errored 3 times");
    expect(result.data).toEqual({ category: "tool_error" });
    expect(result.error).toBeUndefined();
  });

  it("returns identified=false when LLM calls submit_result with identified=false", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_result",
          input: { identified: false, summary: "No errors found", data: {} },
        },
      ],
      stop_reason: "tool_use",
    });

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: '{"span_id":"1","status":"OK"}',
      detector: DETECTOR,
      workspaceId: "",
    });

    expect(result.identified).toBe(false);
    expect(result.summary).toBe("No errors found");
  });

  it("retries when LLM responds with plain text (end_turn without tool_use)", async () => {
    // First call: plain text response
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I think there is an error." }],
      stop_reason: "end_turn",
    });
    // Second call: proper tool use
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_result",
          input: { identified: true, summary: "Found on retry", data: {} },
        },
      ],
      stop_reason: "tool_use",
    });

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: DETECTOR,
      workspaceId: "",
    });

    expect(result.identified).toBe(true);
    expect(result.summary).toBe("Found on retry");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("truncates spansJsonl at 40000 chars", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_result",
          input: { identified: false, summary: "Clean", data: {} },
        },
      ],
      stop_reason: "tool_use",
    });

    const longSpans = "x".repeat(50000);
    await runDetectionForTrace({
      traceId: "t",
      spansJsonl: longSpans,
      detector: DETECTOR,
      workspaceId: "",
    });

    const callArg = mockCreate.mock.calls[0][0];
    const userMessage = callArg.messages[0].content as string;
    // The spans portion should be truncated to 40000 chars
    expect(userMessage.length).toBeLessThan(42000);
  });

  it("returns error when Anthropic throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API rate limit"));

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: DETECTOR,
      workspaceId: "",
    });

    expect(result.error).toBe("API rate limit");
    expect(result.identified).toBe(false);
  });
});
