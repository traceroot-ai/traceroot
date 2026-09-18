import { describe, expect, it, vi } from "vitest";

const withSelfTrace = vi.fn();
withSelfTrace.mockImplementation(async (_meta: any, fn: any) => ({
  ok: true,
  value: await fn(),
  selfTraced: true,
}));
const tracedComplete = vi.fn();
tracedComplete.mockImplementation(async () => ({
  stopReason: "toolUse",
  model: "claude-haiku-4-5",
  provider: "anthropic",
  usage: { input: 10, output: 5, cost: { total: 0.001 } },
  content: [
    { type: "toolCall", name: "submit_digest_summary", arguments: { summary: "3 findings" } },
  ],
}));
vi.mock("../../detection/self-trace-emitter.js", () => ({
  withSelfTrace: (...a: any[]) => withSelfTrace(...a),
  currentSelfTraceScope: () => undefined,
}));
vi.mock("../../detection/traced-complete.js", () => ({
  tracedComplete: (...a: any[]) => tracedComplete(...a),
}));
// The whole point of Task 14 is that generateDigestSummary no longer calls
// complete() directly — it must go through tracedComplete instead.
vi.mock("@earendil-works/pi-ai/compat", () => ({
  complete: vi.fn(() => {
    throw new Error("must not call complete() directly");
  }),
  getEnvApiKey: vi.fn(),
}));
vi.mock("../../detection/sandbox-eval.js", () => ({
  resolveDetectorApiKey: async () => "k",
}));
vi.mock("@traceroot/core/model-resolver", () => ({
  fetchProviderConfig: async () => null,
  resolvePiModel: () => ({ id: "m", provider: "anthropic" }),
}));
vi.mock("@traceroot/core/llm-providers", () => ({
  DETECTOR_SYSTEM_DEFAULT_MODEL_ID: "m",
}));

import { generateDigestSummary } from "../digest-summary.js";

describe("digest summary self-trace", () => {
  it("runs the LLM call through tracedComplete inside a withSelfTrace scope named digest-summary", async () => {
    const windowStart = new Date(1000);
    const windowEnd = new Date(2000);
    const out = await generateDigestSummary(
      {
        projectName: "Acme",
        windowStart,
        windowEnd,
        detectors: [{ name: "D", findingCount: 2, sampleSummaries: ["a"] }],
      },
      { projectId: "p1", workspaceId: "w1", rcaModel: null, rcaProvider: null, rcaSource: null },
    );

    expect(out?.summary).toBe("3 findings");
    expect(withSelfTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        projectId: "p1",
        name: "digest-summary",
        metadata: expect.objectContaining({ kind: "digest" }),
      }),
      expect.any(Function),
    );
    expect(tracedComplete).toHaveBeenCalled();
    // The id the call ran under comes back, for the digest's row to keep.
    expect(out?.trace?.traceId).toBe(withSelfTrace.mock.calls[0][0].traceId);
  });

  it("reports no trace when the worker did not emit one", async () => {
    withSelfTrace.mockImplementationOnce(async (_meta: any, fn: any) => ({
      ok: true,
      value: await fn(),
      selfTraced: false,
    }));
    const out = await generateDigestSummary(
      {
        projectName: "Acme",
        windowStart: new Date(1000),
        windowEnd: new Date(2000),
        detectors: [{ name: "D", findingCount: 2, sampleSummaries: ["a"] }],
      },
      { projectId: "p1", workspaceId: "w1", rcaModel: null, rcaProvider: null, rcaSource: null },
    );
    expect(out?.summary).toBe("3 findings");
    expect(out?.trace).toBeUndefined();
  });

  it("gives two flushes of the same window different trace ids", async () => {
    // A re-flushed window makes a second LLM call with fresh span ids; sharing
    // the trace id would stack a second root under the first trace.
    const input = {
      projectName: "Acme",
      windowStart: new Date(1000),
      windowEnd: new Date(2000),
      detectors: [{ name: "D", findingCount: 2, sampleSummaries: ["a"] }],
    };
    const cfg = {
      projectId: "p1",
      workspaceId: "w1",
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
    };
    withSelfTrace.mockClear();
    await generateDigestSummary(input, cfg);
    await generateDigestSummary(input, cfg);
    const [first, second] = withSelfTrace.mock.calls.map((c) => c[0].traceId as string);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  // An attempt that produced no summary still emitted (and was billed for) a
  // trace. Dropping its id would leave the runs most worth reading — the
  // timeout, the model that never called the tool — pointed at by nothing.
  describe("a failed attempt still reports its trace", () => {
    const input = {
      projectName: "Acme",
      windowStart: new Date(1000),
      windowEnd: new Date(2000),
      detectors: [{ name: "D", findingCount: 2, sampleSummaries: ["a"] }],
    };
    const cfg = {
      projectId: "p1",
      workspaceId: "w1",
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
    };

    it("keeps it when the call times out", async () => {
      tracedComplete.mockImplementationOnce(async () => ({
        stopReason: "aborted",
        model: "m",
        provider: "anthropic",
        content: [],
      }));
      withSelfTrace.mockClear();
      const out = await generateDigestSummary(input, cfg);
      expect(out?.summary).toBeNull();
      expect(out?.failure).toBe("timeout");
      expect(out?.trace?.traceId).toBe(withSelfTrace.mock.calls[0][0].traceId);
    });

    it("keeps it, with the usage it burned, when the model returns no tool call", async () => {
      tracedComplete.mockImplementationOnce(async () => ({
        stopReason: "endTurn",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        usage: { input: 10, output: 5, cost: { total: 0.001 } },
        content: [{ type: "text", text: "here is your summary" }],
      }));
      withSelfTrace.mockClear();
      const out = await generateDigestSummary(input, cfg);
      expect(out?.summary).toBeNull();
      expect(out?.failure).toBe("no-summary");
      expect(out?.trace?.traceId).toBe(withSelfTrace.mock.calls[0][0].traceId);
      // The call ran: it cost tokens even though it answered nothing usable.
      expect(out?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cost: 0.001 });
    });

    it("keeps it when the traced call throws", async () => {
      withSelfTrace.mockImplementationOnce(async (_meta: any, fn: any) => {
        await fn().catch(() => undefined);
        return { ok: false, error: new Error("provider exploded"), selfTraced: true };
      });
      tracedComplete.mockImplementationOnce(async () => {
        throw new Error("provider exploded");
      });
      withSelfTrace.mockClear();
      const out = await generateDigestSummary(input, cfg);
      expect(out?.summary).toBeNull();
      expect(out?.failure).toBe("error");
      expect(out?.trace?.traceId).toBe(withSelfTrace.mock.calls[0][0].traceId);
      // Nothing resolved, so there is no usage to report.
      expect(out?.usage).toBeUndefined();
    });

    it("reports nothing at all when the failure left no trace behind", async () => {
      withSelfTrace.mockImplementationOnce(async (_meta: any, fn: any) => ({
        ok: true,
        value: await fn(),
        selfTraced: false,
      }));
      tracedComplete.mockImplementationOnce(async () => ({
        stopReason: "endTurn",
        model: "m",
        provider: "anthropic",
        content: [],
      }));
      expect(await generateDigestSummary(input, cfg)).toBeNull();
    });

    it("reports nothing when the attempt never got as far as the LLM call", async () => {
      // No detector has sentences: the prompt builder bails before any trace exists.
      withSelfTrace.mockClear();
      const out = await generateDigestSummary(
        { ...input, detectors: [{ name: "D", findingCount: 2, sampleSummaries: [] }] },
        cfg,
      );
      expect(out).toBeNull();
      expect(withSelfTrace).not.toHaveBeenCalled();
    });
  });
});
