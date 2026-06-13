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
vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
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

import { runDetectionForTrace, SAFETY_TRUNCATE_CHARS } from "../sandbox-eval.js";

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

function usageWithCost(total: number) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

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

  it("truncates spansJsonl at 150000 chars", async () => {
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

    const longSpans = "x".repeat(200_000);
    await runDetectionForTrace({
      traceId: "t",
      spansJsonl: longSpans,
      detector: { ...DETECTOR, detectionSource: "system" },
      workspaceId: "ws-1",
    });

    const ctxArg = mockComplete.mock.calls[0][1] as { messages: { content: string }[] };
    const userMessage = ctxArg.messages[0].content;
    expect(typeof userMessage).toBe("string");
    expect((userMessage as string).length).toBeLessThan(152_000);
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

  describe("incomplete-input disclosure", () => {
    function cleanSubmitResponse() {
      return {
        content: [
          {
            type: "toolCall",
            name: "submit_result",
            arguments: { identified: false, summary: "clean", data: {} },
          },
        ],
        usage: ZERO_USAGE,
        stopReason: "toolUse",
      };
    }

    async function userTextFor(spansJsonl: string, partialReason?: string | null) {
      mockComplete.mockResolvedValueOnce(cleanSubmitResponse());
      await runDetectionForTrace({
        traceId: "t",
        spansJsonl,
        detector: { ...DETECTOR, detectionSource: "system" },
        workspaceId: "ws-1",
        partialReason,
      });
      const ctxArg = mockComplete.mock.calls[0][1] as { messages: { content: string }[] };
      return ctxArg.messages[0].content;
    }

    it("discloses an in-flight trace when partialReason is set", async () => {
      const userText = await userTextFor("{}", "cap_expired");
      expect(userText).toContain("may be INCOMPLETE");
      expect(userText).toContain("trace still in flight when evaluated");
      expect(userText).not.toContain("truncated at");
    });

    it("discloses truncation when input exceeds the safety cap", async () => {
      const userText = await userTextFor("x".repeat(SAFETY_TRUNCATE_CHARS + 1));
      expect(userText).toContain("may be INCOMPLETE");
      expect(userText).toContain(`span list truncated at ${SAFETY_TRUNCATE_CHARS} chars`);
      expect(userText).not.toContain("in flight");
    });

    it("joins both reasons into the single note", async () => {
      const userText = await userTextFor("x".repeat(SAFETY_TRUNCATE_CHARS + 1), "no_progress");
      expect(userText).toContain("trace still in flight when evaluated");
      expect(userText).toContain(`span list truncated at ${SAFETY_TRUNCATE_CHARS} chars`);
      expect(userText.match(/INCOMPLETE/g)).toHaveLength(1);
    });

    it("omits the note for a settled, untruncated trace", async () => {
      const userText = await userTextFor("{}", null);
      expect(userText).not.toContain("INCOMPLETE");
    });
  });

  describe("inference cost + source attribution", () => {
    it("captures system source cost on happy path", async () => {
      mockComplete.mockResolvedValueOnce({
        content: [
          {
            type: "toolCall",
            name: "submit_result",
            arguments: { identified: false, summary: "clean", data: {} },
          },
        ],
        usage: usageWithCost(0.0042),
        stopReason: "toolUse",
      });

      const result = await runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: { ...DETECTOR, detectionSource: "system" },
        workspaceId: "ws-1",
      });

      expect(result.inferenceCost).toBeCloseTo(0.0042, 6);
      expect(result.inferenceSource).toBe("system");
    });

    it("sums cost across attempts on retry-then-success", async () => {
      mockComplete
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "ignoring instructions" }],
          usage: usageWithCost(0.001),
          stopReason: "stop",
        })
        .mockResolvedValueOnce({
          content: [
            {
              type: "toolCall",
              name: "submit_result",
              arguments: { identified: true, summary: "found", data: {} },
            },
          ],
          usage: usageWithCost(0.003),
          stopReason: "toolUse",
        });

      const result = await runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: { ...DETECTOR, detectionSource: "system" },
        workspaceId: "ws-1",
      });

      expect(result.identified).toBe(true);
      expect(result.inferenceCost).toBeCloseTo(0.004, 6);
      expect(result.inferenceSource).toBe("system");
    });

    it("captures BYOK source attribution with positive cost", async () => {
      mockFetchProviderConfig.mockResolvedValueOnce({
        key: "byok-key",
        provider: "anthropic",
        model: "claude-haiku-4-5",
      });
      mockComplete.mockResolvedValueOnce({
        content: [
          {
            type: "toolCall",
            name: "submit_result",
            arguments: { identified: false, summary: "ok", data: {} },
          },
        ],
        usage: usageWithCost(0.005),
        stopReason: "toolUse",
      });

      const result = await runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: {
          ...DETECTOR,
          detectionSource: "byok",
          detectionProvider: "byok-provider",
        },
        workspaceId: "ws-1",
      });

      expect(result.inferenceSource).toBe("byok");
      expect(result.inferenceCost).toBeCloseTo(0.005, 6);
    });

    it("preserves source on error path with cost=0 (early-exit, BYOK provider missing)", async () => {
      mockFetchProviderConfig.mockResolvedValueOnce(null);

      const result = await runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: {
          ...DETECTOR,
          detectionSource: "byok",
          detectionProvider: "missing",
        },
        workspaceId: "ws-1",
      });

      expect(result.error).toMatch(/not found or disabled/i);
      expect(result.inferenceCost).toBe(0);
      expect(result.inferenceSource).toBe("byok");
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("preserves source on error path with cost=0 (complete() throws)", async () => {
      mockComplete.mockRejectedValueOnce(new Error("network down"));

      const result = await runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: { ...DETECTOR, detectionSource: "system" },
        workspaceId: "ws-1",
      });

      expect(result.error).toBe("network down");
      expect(result.inferenceCost).toBe(0);
      expect(result.inferenceSource).toBe("system");
    });

    it("treats null source as null on the EvalResult (processor normalizes)", async () => {
      mockComplete.mockResolvedValueOnce({
        content: [
          {
            type: "toolCall",
            name: "submit_result",
            arguments: { identified: false, summary: "ok", data: {} },
          },
        ],
        usage: usageWithCost(0.002),
        stopReason: "toolUse",
      });

      const detectorWithoutSource = { ...DETECTOR };
      const result = await runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: detectorWithoutSource,
        workspaceId: "ws-1",
      });

      expect(result.inferenceSource).toBeNull();
      expect(result.inferenceCost).toBeCloseTo(0.002, 6);
    });
  });
});
