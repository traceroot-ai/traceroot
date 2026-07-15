import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildDigestSummaryPrompt,
  buildDigestSummaryTool,
  DIGEST_SUMMARY_MAX_PROMPT_CHARS,
  type DigestSummaryInput,
} from "../digest-summary.js";

const complete = vi.fn();
const resolveDetectorApiKey = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
  complete: (...a: any[]) => complete(...a),
  getEnvApiKey: vi.fn(),
}));
vi.mock("../../detection/sandbox-eval.js", () => ({
  resolveDetectorApiKey: (...a: any[]) => resolveDetectorApiKey(...a),
}));
vi.mock("@traceroot/core/model-resolver", () => ({
  resolvePiModel: vi.fn(() => ({
    id: "claude-haiku-4-5",
    provider: "anthropic",
    api: "anthropic-messages",
  })),
  fetchProviderConfig: vi.fn(async () => null),
}));
vi.mock("@traceroot/core/llm-providers", () => ({
  DETECTOR_SYSTEM_DEFAULT_MODEL_ID: "claude-haiku-4-5",
}));

// Dynamic import AFTER mocks, like detector-digest-processor.test.ts:
async function callGenerate(cfgOverrides = {}) {
  const { generateDigestSummary } = await import("../digest-summary.js");
  return generateDigestSummary(
    {
      projectName: "Acme",
      windowStart: new Date("2026-07-13T19:00:00Z"),
      windowEnd: new Date("2026-07-13T19:10:00Z"),
      detectors: [{ name: "D", findingCount: 2, sampleSummaries: ["a", "b"] }],
    },
    { workspaceId: "ws1", rcaModel: null, rcaProvider: null, rcaSource: null, ...cfgOverrides },
  );
}

const WINDOW = {
  windowStart: new Date("2026-07-13T19:00:00Z"),
  windowEnd: new Date("2026-07-13T19:10:00Z"),
};

function input(detectors: DigestSummaryInput["detectors"]): DigestSummaryInput {
  return { projectName: "Acme", ...WINDOW, detectors };
}

describe("buildDigestSummaryPrompt", () => {
  it("includes detector name, count, and each sentence", () => {
    const p = buildDigestSummaryPrompt(
      input([{ name: "Failure Detector", findingCount: 2, sampleSummaries: ["a", "b"] }]),
    );
    expect(p).not.toBeNull();
    expect(p!.userText).toContain("Failure Detector");
    expect(p!.userText).toContain("2 findings");
    expect(p!.userText).toContain("- a");
    expect(p!.userText).toContain("- b");
  });

  it("returns null when no detector has any sentences", () => {
    expect(
      buildDigestSummaryPrompt(input([{ name: "D", findingCount: 3, sampleSummaries: [] }])),
    ).toBeNull();
  });

  it("keeps zero-sample detectors with an explicit no-sample disclosure", () => {
    const p = buildDigestSummaryPrompt(
      input([
        { name: "Sampled", findingCount: 2, sampleSummaries: ["a"] },
        { name: "Starved", findingCount: 5, sampleSummaries: [] },
      ]),
    );
    expect(p!.userText).toContain("DETECTOR: Starved — 5 findings (no sample available)");
  });

  it("discloses sampling when findingCount exceeds the sample", () => {
    const p = buildDigestSummaryPrompt(
      input([{ name: "D", findingCount: 3412, sampleSummaries: ["x", "y"] }]),
    );
    expect(p!.userText).toContain("latest 2 of 3412 findings");
  });

  it("drops whole detectors (largest kept first) to stay under the char budget", () => {
    const bigSentence = "s".repeat(300);
    const detectors = Array.from({ length: 80 }, (_, i) => ({
      name: `detector-${i}`,
      findingCount: 80 - i, // detector-0 has the most findings
      sampleSummaries: Array.from({ length: 10 }, () => bigSentence),
    }));
    const p = buildDigestSummaryPrompt(input(detectors));
    expect(p).not.toBeNull();
    expect(p!.userText.length).toBeLessThanOrEqual(DIGEST_SUMMARY_MAX_PROMPT_CHARS);
    expect(p!.userText).toContain("detector-0"); // biggest survives
    expect(p!.userText).not.toContain("detector-79"); // smallest dropped whole
    // Dropped detectors are disclosed so the model doesn't treat the list as complete.
    expect(p!.userText).toMatch(/\+\d+ more detectors omitted/);
  });

  it("stays under the cap even when sections land exactly on the budget boundary", () => {
    // Sweep section sizes so at least one packing lands flush against the
    // budget; the omission tail must be reserved, never overflow the cap.
    for (let sentenceLen = 280; sentenceLen <= 320; sentenceLen++) {
      const detectors = Array.from({ length: 200 }, (_, i) => ({
        name: `d-${i}`,
        findingCount: 200 - i,
        sampleSummaries: Array.from({ length: 10 }, () => "x".repeat(sentenceLen)),
      }));
      const p = buildDigestSummaryPrompt(input(detectors));
      expect(p).not.toBeNull();
      expect(p!.userText.length).toBeLessThanOrEqual(DIGEST_SUMMARY_MAX_PROMPT_CHARS);
      expect(p!.userText).toMatch(/\+\d+ more detectors omitted/);
    }
  });
});

describe("buildDigestSummaryTool", () => {
  it("requires a single summary string", () => {
    const tool = buildDigestSummaryTool();
    expect(tool.name).toBe("submit_digest_summary");
    expect((tool.parameters as any).required).toEqual(["summary"]);
  });
});

describe("generateDigestSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveDetectorApiKey.mockResolvedValue("sk-test");
  });

  it("returns the tool-call summary and usage on success", async () => {
    complete.mockResolvedValue({
      stopReason: "toolUse",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      usage: { input: 900, output: 60, cost: { total: 0.001 } },
      content: [
        {
          type: "toolCall",
          name: "submit_digest_summary",
          arguments: { summary: "Payments API is down." },
        },
      ],
    });
    const r = await callGenerate();
    expect(r).toEqual({
      summary: "Payments API is down.",
      usage: {
        model: "claude-haiku-4-5",
        provider: "anthropic",
        isByok: false,
        inputTokens: 900,
        outputTokens: 60,
        cost: 0.001,
      },
    });
  });

  it("returns null when the model never calls the tool", async () => {
    complete.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "hi" }],
      usage: {},
    });
    expect(await callGenerate()).toBeNull();
  });

  it("returns null when complete() rejects", async () => {
    complete.mockRejectedValue(new Error("boom"));
    expect(await callGenerate()).toBeNull();
  });

  it("returns null when no API key resolves", async () => {
    resolveDetectorApiKey.mockResolvedValue(null);
    expect(await callGenerate()).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns null when the tool returns an empty summary", async () => {
    complete.mockResolvedValue({
      stopReason: "toolUse",
      content: [{ type: "toolCall", name: "submit_digest_summary", arguments: { summary: "   " } }],
      usage: {},
    });
    expect(await callGenerate()).toBeNull();
  });
});

describe("parseDigestSummaryTimeoutMs", () => {
  it("falls back to 15000 for empty and non-numeric values", async () => {
    const { parseDigestSummaryTimeoutMs } = await import("../digest-summary.js");
    expect(parseDigestSummaryTimeoutMs("")).toBe(15_000);
    expect(parseDigestSummaryTimeoutMs("15s")).toBe(15_000);
  });
});
