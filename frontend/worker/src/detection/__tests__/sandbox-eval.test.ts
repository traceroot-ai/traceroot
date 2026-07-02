import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockComplete,
  mockGetEnvApiKey,
  mockResolvePiModel,
  mockFetchProviderConfig,
  mockFindByokKey,
} = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockGetEnvApiKey: vi.fn(),
  mockResolvePiModel: vi.fn(),
  mockFetchProviderConfig: vi.fn(),
  mockFindByokKey: vi.fn().mockResolvedValue(null),
}));

// Forward unmocked exports (Type, getModel, etc.) so submit-result-tool.ts's
// TypeBox imports still work; only `complete` is replaced with the mock.
vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return {
    ...actual,
    complete: mockComplete,
    getEnvApiKey: mockGetEnvApiKey,
  };
});

vi.mock("@traceroot/core/model-resolver", () => ({
  resolvePiModel: mockResolvePiModel,
  fetchProviderConfig: mockFetchProviderConfig,
  findByokKeyForPiProvider: mockFindByokKey,
}));

import {
  runDetectionForTrace,
  parseDetectorEvalTimeoutMs,
  DEFAULT_DETECTOR_EVAL_TIMEOUT_MS,
  MAX_DETECTOR_EVAL_TIMEOUT_MS,
} from "../sandbox-eval.js";

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

const OPENAI_MODEL = {
  id: "gpt-5.4-mini",
  api: "openai-completions",
  provider: "openai",
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
    mockGetEnvApiKey.mockReturnValue("test-api-key");
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

  it("uses the detector system default for legacy null-source detectors without a stored model", async () => {
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

    await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: { ...DETECTOR, detectionSource: null, detectionModel: null },
      workspaceId: "ws-1",
    });

    expect(mockResolvePiModel).toHaveBeenCalledWith("claude-haiku-4-5", null);
  });

  it("uses the OpenAI detector system default when Anthropic env is absent", async () => {
    mockGetEnvApiKey.mockImplementation((provider: string) =>
      provider === "openai" ? "openai-key" : null,
    );
    mockResolvePiModel.mockReturnValueOnce(OPENAI_MODEL);
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

    await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: { ...DETECTOR, detectionSource: "system", detectionModel: null },
      workspaceId: "ws-1",
    });

    expect(mockResolvePiModel).toHaveBeenCalledWith("gpt-5.4-mini", null);
  });

  it("does not use workspace BYOK keys for explicit system-source detectors", async () => {
    mockGetEnvApiKey.mockReturnValue(null);
    mockFindByokKey.mockResolvedValueOnce("workspace-byok-key");

    const result = await runDetectionForTrace({
      traceId: "trace-abc",
      spansJsonl: "{}",
      detector: { ...DETECTOR, detectionSource: "system", detectionModel: null },
      workspaceId: "ws-1",
    });

    expect(result.identified).toBe(false);
    expect(result.error).toBe('No API key configured for provider "anthropic"');
    expect(mockFindByokKey).not.toHaveBeenCalled();
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

  it("passes an AbortSignal to complete() so the call is cancellable", async () => {
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

    const opts = mockComplete.mock.calls[0][2] as { signal?: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts and returns a timeout error when the provider never responds", async () => {
    // Pin the timeout so the test is deterministic regardless of any ambient
    // DETECTOR_EVAL_TIMEOUT_MS, and advance to exactly the configured bound.
    vi.stubEnv("DETECTOR_EVAL_TIMEOUT_MS", "5000");
    vi.useFakeTimers();
    try {
      // Simulate a hung provider: the promise only settles if its signal aborts.
      mockComplete.mockImplementationOnce((_model, _ctx, opts) => {
        const { signal } = opts as { signal: AbortSignal };
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const promise = runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: { ...DETECTOR, detectionSource: "system" },
        workspaceId: "ws-1",
      });

      // Advance past the eval timeout; the AbortController fires and the call rejects.
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.identified).toBe(false);
      expect(result.error).toMatch(/timed out after 5000ms/i);
      expect(mockComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("classifies an aborted response (stopReason=aborted) as a timeout without retrying", async () => {
    vi.stubEnv("DETECTOR_EVAL_TIMEOUT_MS", "5000");
    vi.useFakeTimers();
    try {
      // pi-ai may RESOLVE (not throw) with an aborted response once the signal
      // fires: stopReason "aborted" + empty content. This must be treated as a
      // timeout, not as a missing submit_result (which would retry).
      mockComplete.mockImplementationOnce((_model, _ctx, opts) => {
        const { signal } = opts as { signal: AbortSignal };
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ stopReason: "aborted", content: [], usage: ZERO_USAGE });
          });
        });
      });

      const promise = runDetectionForTrace({
        traceId: "t",
        spansJsonl: "{}",
        detector: { ...DETECTOR, detectionSource: "system" },
        workspaceId: "ws-1",
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.identified).toBe(false);
      expect(result.error).toMatch(/timed out/i);
      expect(result.error).not.toMatch(/did not call submit_result/i);
      expect(mockComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  describe("parseDetectorEvalTimeoutMs", () => {
    it("accepts valid positive values up to the Node timer max", () => {
      expect(parseDetectorEvalTimeoutMs("30000")).toBe(30000);
      expect(parseDetectorEvalTimeoutMs(String(MAX_DETECTOR_EVAL_TIMEOUT_MS))).toBe(
        MAX_DETECTOR_EVAL_TIMEOUT_MS,
      );
    });

    it.each([
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace", "   "],
      ["zero", "0"],
      ["negative", "-1000"],
      ["Infinity", "Infinity"],
      ["non-numeric", "abc"],
      ["over the Node timer max", String(MAX_DETECTOR_EVAL_TIMEOUT_MS + 1)],
    ])("falls back to the default for %s", (_label, raw) => {
      expect(parseDetectorEvalTimeoutMs(raw as string | undefined)).toBe(
        DEFAULT_DETECTOR_EVAL_TIMEOUT_MS,
      );
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
