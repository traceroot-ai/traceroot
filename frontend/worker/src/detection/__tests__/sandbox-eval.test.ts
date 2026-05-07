import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockComplete, mockResolvePiModel, mockFetchProviderConfig, mockFindByokKey } = vi.hoisted(
  () => ({
    mockComplete: vi.fn(),
    mockResolvePiModel: vi.fn(),
    mockFetchProviderConfig: vi.fn(),
    mockFindByokKey: vi.fn().mockResolvedValue(null),
  }),
);

// Forward unmocked exports (Type, getModel, etc.) so submit-result-tool.ts's
// TypeBox imports still work; only `complete` is replaced with the mock.
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: mockComplete,
  };
});

vi.mock("@traceroot/core/model-resolver", () => ({
  resolvePiModel: mockResolvePiModel,
  fetchProviderConfig: mockFetchProviderConfig,
  findByokKeyForPiProvider: mockFindByokKey,
}));

import { runDetectionForTrace } from "../sandbox-eval.js";

const DETECTOR = {
  id: "det-1",
  name: "error detector",
  prompt: "Detect tool errors",
  outputSchema: [{ name: "category", type: "string" }],
};

const ANTHROPIC_MODEL = {
  id: "claude-haiku-4-5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("runDetectionForTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePiModel.mockReturnValue(ANTHROPIC_MODEL);
    // Default: workspace BYOK scan returns a key. Individual tests can override
    // by chaining mockResolvedValueOnce(null) before the call to simulate "no key".
    mockFindByokKey.mockResolvedValue("test-api-key");
  });

  it("returns identified=true when LLM emits a submit_result toolCall", async () => {
    mockComplete.mockResolvedValueOnce({
      content: [
        {
          type: "toolCall",
          name: "submit_result",
          arguments: {
            identified: true,
            summary: "Tool errored 3 times",
            data: { category: "tool_error" },
          },
        },
      ],
      usage: ZERO_USAGE,
      stopReason: "toolUse",
    });

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: '{"span_id":"1","status":"ERROR"}',
      detector: { ...DETECTOR, detectionSource: "system", detectionModel: "claude-haiku-4-5" },
      workspaceId: "ws-1",
    });

    expect(result.identified).toBe(true);
    expect(result.summary).toBe("Tool errored 3 times");
    expect(result.data).toEqual({ category: "tool_error" });
    expect(result.error).toBeUndefined();
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("retries on plain-text response and succeeds on second attempt", async () => {
    mockComplete
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "I think there is an error." }],
        usage: ZERO_USAGE,
        stopReason: "stop",
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "toolCall",
            name: "submit_result",
            arguments: { identified: true, summary: "Found on retry", data: {} },
          },
        ],
        usage: ZERO_USAGE,
        stopReason: "toolUse",
      });

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: { ...DETECTOR, detectionSource: "system" },
      workspaceId: "ws-1",
    });

    expect(result.identified).toBe(true);
    expect(result.summary).toBe("Found on retry");
    expect(mockComplete).toHaveBeenCalledTimes(2);
  });

  it("returns error and does not call complete() when BYOK provider not found", async () => {
    mockFetchProviderConfig.mockResolvedValueOnce(null);

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: {
        ...DETECTOR,
        detectionSource: "byok",
        detectionProvider: "missing-provider",
      },
      workspaceId: "ws-1",
    });

    expect(result.identified).toBe(false);
    expect(result.error).toMatch(/not found or disabled/i);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("always passes toolChoice='auto' regardless of protocol", async () => {
    // We send "auto" universally — the system prompt + retry loop are what
    // get the model to call submit_result, not a protocol-level force flag.
    // See sandbox-eval.ts TOOL_CHOICE for the reasoning.
    const apis = [
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
      "bedrock-converse-stream",
      "google-generative-ai",
    ];

    for (const api of apis) {
      mockComplete.mockClear();
      mockResolvePiModel.mockReturnValueOnce({ ...ANTHROPIC_MODEL, api });
      mockComplete.mockResolvedValueOnce({
        content: [
          {
            type: "toolCall",
            name: "submit_result",
            arguments: { identified: false, summary: "ok", data: {} },
          },
        ],
        usage: ZERO_USAGE,
        stopReason: "toolUse",
      });

      await runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: { ...DETECTOR, detectionSource: "system" },
        workspaceId: "ws-1",
      });

      const optsArg = mockComplete.mock.calls[0][2] as { toolChoice: string };
      expect(optsArg.toolChoice).toBe("auto");
    }
  });

  it("truncates spansJsonl at 40000 chars", async () => {
    mockComplete.mockResolvedValueOnce({
      content: [
        {
          type: "toolCall",
          name: "submit_result",
          arguments: { identified: false, summary: "Clean", data: {} },
        },
      ],
      usage: ZERO_USAGE,
      stopReason: "toolUse",
    });

    const longSpans = "x".repeat(50000);
    await runDetectionForTrace({
      traceId: "t",
      spansJsonl: longSpans,
      detector: { ...DETECTOR, detectionSource: "system" },
      workspaceId: "ws-1",
    });

    const ctxArg = mockComplete.mock.calls[0][1] as { messages: { content: string }[] };
    const userMessage = ctxArg.messages[0].content;
    expect(typeof userMessage).toBe("string");
    expect((userMessage as string).length).toBeLessThan(42000);
  });

  it("returns error when complete() throws", async () => {
    mockComplete.mockRejectedValueOnce(new Error("API rate limit"));

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: { ...DETECTOR, detectionSource: "system" },
      workspaceId: "ws-1",
    });

    expect(result.identified).toBe(false);
    expect(result.error).toBe("API rate limit");
  });
});
