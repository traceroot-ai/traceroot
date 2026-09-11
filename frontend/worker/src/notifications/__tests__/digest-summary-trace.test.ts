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
});
