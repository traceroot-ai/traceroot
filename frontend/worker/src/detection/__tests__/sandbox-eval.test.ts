import { describe, it, expect, vi, beforeEach } from "vitest";

const mockComplete = vi.fn();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: (...args: unknown[]) => mockComplete(...args),
    getEnvApiKey: vi.fn(() => "sk-test"),
  };
});

vi.mock("@traceroot/core/pi-model", () => ({
  resolvePiModel: vi.fn(() => ({
    id: "claude-haiku-4-5",
    name: "claude-haiku-4-5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  })),
}));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  const findUnique = vi.fn().mockResolvedValue(null);
  const findMany = vi.fn().mockResolvedValue([]);
  return {
    ...actual,
    prisma: new Proxy(actual.prisma, {
      get(target, prop, receiver) {
        if (prop === "modelProvider") {
          return { findUnique, findMany };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

import { runDetectionForTrace } from "../sandbox-eval";

const DETECTOR = {
  id: "det-1",
  name: "error detector",
  prompt: "Detect tool errors",
  outputSchema: [{ name: "category", type: "string" }],
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantWithTool(args: Record<string, unknown>) {
  return {
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        id: "toolu_1",
        name: "submit_result",
        arguments: args,
      },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: emptyUsage,
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };
}

describe("runDetectionForTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns identified=true when LLM calls submit_result with identified=true", async () => {
    mockComplete.mockResolvedValueOnce(
      assistantWithTool({
        identified: true,
        summary: "Tool errored 3 times",
        data: { category: "tool_error" },
      }),
    );

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
    mockComplete.mockResolvedValueOnce(
      assistantWithTool({ identified: false, summary: "No errors found", data: {} }),
    );

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: '{"span_id":"1","status":"OK"}',
      detector: DETECTOR,
      workspaceId: "",
    });

    expect(result.identified).toBe(false);
    expect(result.summary).toBe("No errors found");
  });

  it("retries when LLM responds with plain text (no tool call)", async () => {
    mockComplete.mockResolvedValueOnce({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "I think there is an error." }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: emptyUsage,
      stopReason: "stop" as const,
      timestamp: Date.now(),
    });
    mockComplete.mockResolvedValueOnce(
      assistantWithTool({ identified: true, summary: "Found on retry", data: {} }),
    );

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: DETECTOR,
      workspaceId: "",
    });

    expect(result.identified).toBe(true);
    expect(result.summary).toBe("Found on retry");
    expect(mockComplete).toHaveBeenCalledTimes(2);
  });

  it("truncates spansJsonl at 40000 chars", async () => {
    mockComplete.mockResolvedValueOnce(
      assistantWithTool({ identified: false, summary: "Clean", data: {} }),
    );

    const longSpans = "x".repeat(50000);
    await runDetectionForTrace({
      traceId: "t",
      spansJsonl: longSpans,
      detector: DETECTOR,
      workspaceId: "",
    });

    const callArg = mockComplete.mock.calls[0][1] as { messages: { content: string }[] };
    const userMessage = callArg.messages[0].content as string;
    expect(userMessage.length).toBeLessThan(42000);
  });

  it("returns error when complete throws", async () => {
    mockComplete.mockRejectedValueOnce(new Error("API rate limit"));

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
