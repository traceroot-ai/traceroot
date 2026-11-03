import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCallDecisions, mockCalculateCost, mockTracedDecision } = vi.hoisted(() => ({
  mockCallDecisions: vi.fn(),
  mockCalculateCost: vi.fn(),
  // Runs the call untraced; the test reads the meta and callbacks it was given.
  mockTracedDecision: vi.fn((_meta: unknown, call: () => Promise<unknown>) => call()),
}));

vi.mock("../openai-decisions-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../openai-decisions-client.js")>()),
  callDecisions: mockCallDecisions,
}));
vi.mock("@traceroot/core", () => ({ calculateCost: mockCalculateCost }));
vi.mock("../traced-system-one.js", () => ({ tracedDecision: mockTracedDecision }));

import {
  decisionsCost,
  decisionsCostFromError,
  openAIDecisionModel,
  runOpenAIDecisionDetection,
} from "../openai-decision-eval.js";
import type { DetectorConfig } from "../sandbox-eval.js";

const DETECTOR: DetectorConfig = {
  id: "det-decisions",
  name: "failure detector",
  prompt: "Flag traces where a tool call fails and the agent continues.",
  outputSchema: [],
  detectionModel: "gpt-6-luna-decisions",
  detectionProvider: "my-openai",
  detectionSource: "byok",
  template: "failure",
};

const PROVIDER_CONFIG = {
  adapter: "openai",
  key: "sk-secret-key",
  baseUrl: null,
  config: null,
};

const SPANS =
  '{"trace_id":"t-1","span_id":"s1","name":"agent.run","input":"{\\"task\\":\\"weather\\"}"}\n' +
  '{"trace_id":"t-1","span_id":"s2","name":"tool.get_weather","status":"ERROR"}';

const FAILURE_PROBS = {
  tool_error: 0.91,
  silent_failure: 0,
  loop: 0,
  timeout: 0.06,
  swallowed_error: 0.01,
  other: 0.01,
  none: 0.01,
};

const USAGE = { inputTokens: 1_000, cachedTokens: 600, cacheWriteTokens: 100, outputTokens: 0 };

function result(gate: number, probabilities: Record<string, number>) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return {
    model: null as string | null,
    answers: {
      gate: { type: "predicate", probability: gate },
      label: { type: "choice", choice, confidence: 0.88, probabilities },
    },
    usage: USAGE,
  };
}

function run(overrides: Partial<Parameters<typeof runOpenAIDecisionDetection>[0]> = {}) {
  return runOpenAIDecisionDetection({
    spansJsonl: SPANS,
    detector: DETECTOR,
    providerConfig: PROVIDER_CONFIG,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function sentOptions() {
  return mockCallDecisions.mock.calls[0][0];
}

describe("openAIDecisionModel", () => {
  it("maps the alias to gpt-6-luna and nothing else to a model", () => {
    expect(openAIDecisionModel("gpt-6-luna-decisions")).toBe("gpt-6-luna");
    for (const id of ["gpt-6-luna", "jev-1.13.0", "", null, undefined]) {
      expect(openAIDecisionModel(id)).toBeNull();
    }
  });
});

describe("decisionsCost", () => {
  beforeEach(() => {
    mockCalculateCost.mockReset();
  });

  it("prices uncached input, cache reads and cache writes apart, and no output", async () => {
    mockCalculateCost.mockResolvedValue(0.000042);
    expect(await decisionsCost("gpt-6-luna", { ...USAGE, outputTokens: 5 })).toBe(0.000042);
    expect(mockCalculateCost).toHaveBeenCalledWith("gpt-6-luna", 300, 0, 600, 100);
  });

  it("is null when the price lookup fails", async () => {
    mockCalculateCost.mockRejectedValue(new Error("db down"));
    expect(await decisionsCost("gpt-6-luna", USAGE)).toBeNull();
  });
});

describe("decisionsCostFromError", () => {
  it("reads only a finite, non-negative cost off an Error", () => {
    expect(decisionsCostFromError(Object.assign(new Error("x"), { cost: 0.5 }))).toBe(0.5);
    expect(decisionsCostFromError(Object.assign(new Error("x"), { cost: 0 }))).toBe(0);
    for (const cost of [-1, Number.NaN, "0.5", undefined]) {
      expect(decisionsCostFromError(Object.assign(new Error("x"), { cost }))).toBeNull();
    }
    expect(decisionsCostFromError({ cost: 0.5 })).toBeNull();
  });
});

describe("runOpenAIDecisionDetection", () => {
  beforeEach(() => {
    mockCallDecisions.mockReset();
    mockTracedDecision.mockClear();
    mockCalculateCost.mockReset();
    mockCalculateCost.mockResolvedValue(0.000042);
  });

  it("fires on the gate and reports the category, the cost and gpt-6-luna as the model", async () => {
    mockCallDecisions.mockResolvedValueOnce(result(0.97, FAILURE_PROBS));

    const res = await run();

    expect(res.identified).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.summary).toBe(
      "Tool error (91% likely); runner-up: timeout (6%); no written rationale.",
    );
    expect(res.data).toEqual({
      category: "tool_error",
      probabilities: FAILURE_PROBS,
      confidence: 0.88,
      gate: 0.97,
    });
    expect(res).toMatchObject({
      inferenceCost: 0.000042,
      inferenceInputTokens: 1_000,
      inferenceOutputTokens: 0,
      inferenceSource: "byok",
      inferenceModel: "gpt-6-luna",
      inferenceProvider: "openai",
      skipCostFallback: true,
    });
  });

  it("calls gpt-6-luna, not the alias, on the default base URL with the provider key", async () => {
    mockCallDecisions.mockResolvedValueOnce(result(0.2, FAILURE_PROBS));

    const res = await run();

    expect(sentOptions()).toMatchObject({
      apiKey: "sk-secret-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6-luna",
      deadlineMs: 5_000,
    });
    expect(res.identified).toBe(false);
    expect(res.summary).toBe("No problem found (20% chance of one).");
  });

  it("uses the provider's base URL when it sets one", async () => {
    mockCallDecisions.mockResolvedValueOnce(result(0.2, FAILURE_PROBS));
    await run({ providerConfig: { ...PROVIDER_CONFIG, baseUrl: "https://proxy.example.com/v1" } });
    expect(sentOptions().baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("sends the projected trace and the prompt as data, and the template's questions", async () => {
    mockCallDecisions.mockResolvedValueOnce(result(0.2, FAILURE_PROBS));

    await run();

    const { input, questions } = sentOptions();
    const data = input[0].content[0].data;
    expect(input[0].content[0].type).toBe("input_json");
    expect(data.detector_criteria).toBe(DETECTOR.prompt);
    expect(data.trace.trace_id).toBe("t-1");
    expect(data.trace.spans.map((s: { name: string }) => s.name)).toEqual([
      "agent.run",
      "tool.get_weather",
    ]);
    expect(questions.gate.type).toBe("predicate");
    expect(questions.label.choices.map((c: { value: string }) => c.value)).toEqual(
      Object.keys(FAILURE_PROBS),
    );
  });

  it.each([
    [0.5, true],
    [0.49, false],
  ])("gate P=%s fires=%s", async (gate, fires) => {
    mockCallDecisions.mockResolvedValueOnce(result(gate, FAILURE_PROBS));
    const res = await run();
    expect(res.identified).toBe(fires);
    expect(res.data.gate).toBe(gate);
  });

  it("asks {problem, none} for a blank detector", async () => {
    mockCallDecisions.mockResolvedValueOnce(result(0.8, { problem: 0.75, none: 0.25 }));

    const res = await run({ detector: { ...DETECTOR, template: "blank" } });

    expect(sentOptions().questions.label.choices.map((c: { value: string }) => c.value)).toEqual([
      "problem",
      "none",
    ]);
    expect(res.summary).toBe("Problem (75% likely); no written rationale.");
  });

  it("throws for a model that is not an OpenAI decision alias, without calling the API", async () => {
    await expect(run({ detector: { ...DETECTOR, detectionModel: "gpt-6-luna" } })).rejects.toThrow(
      /not an OpenAI decision model/,
    );
    expect(mockCallDecisions).not.toHaveBeenCalled();
  });

  it("traces the call as gpt-6-luna with decision.* attributes and the cache split", async () => {
    mockCallDecisions.mockResolvedValueOnce(result(0.97, FAILURE_PROBS));

    await run();

    const [meta, , finish, failedUsage] = mockTracedDecision.mock.calls[0] as unknown as [
      { name: string; model: string; attributes: Record<string, string> },
      unknown,
      (r: ReturnType<typeof result> & { cost: number | null }) => {
        model: string | null;
        attributes: Record<string, unknown>;
      },
      (err: unknown) => Record<string, number> | null,
    ];
    expect(meta.name).toBe("decisions gpt-6-luna");
    expect(meta.model).toBe("gpt-6-luna");
    expect(meta.attributes).toEqual({
      "decision.system": "openai",
      "decision.provider": "openai",
      "decision.model_name": "gpt-6-luna",
    });
    const usageAttributes = {
      "gen_ai.usage.input_tokens": 1_000,
      "gen_ai.usage.output_tokens": 0,
      "gen_ai.usage.cache_read.input_tokens": 600,
      "gen_ai.usage.cache_creation.input_tokens": 100,
      "decision.token_count.input": 1_000,
      "decision.token_count.output": 0,
    };
    expect(finish({ ...result(0.97, FAILURE_PROBS), cost: 0.000042 }).attributes).toEqual({
      ...usageAttributes,
      "llm.cost.total": 0.000042,
      "decision.model_name": "gpt-6-luna",
    });
    // Unpriced: no reported cost, so ingest prices the tokens itself.
    expect(
      finish({ ...result(0.97, FAILURE_PROBS), cost: null }).attributes["llm.cost.total"],
    ).toBeUndefined();
    const dated = { ...result(0.97, FAILURE_PROBS), model: "gpt-6-luna-2026-09-30", cost: 0 };
    expect(finish(dated)).toMatchObject({
      model: "gpt-6-luna-2026-09-30",
      attributes: { "decision.model_name": "gpt-6-luna-2026-09-30" },
    });
    expect(
      failedUsage(Object.assign(new Error("refused"), { usage: USAGE, cost: 0.00003 })),
    ).toEqual({ ...usageAttributes, "llm.cost.total": 0.00003 });
    expect(failedUsage(new Error("401"))).toBeNull();
  });

  it("records one cost on the run and the span, pricing reported output at zero", async () => {
    const withOutput = { ...result(0.97, FAILURE_PROBS), usage: { ...USAGE, outputTokens: 7 } };
    mockCallDecisions.mockResolvedValueOnce(withOutput);
    let traced: unknown;
    mockTracedDecision.mockImplementationOnce(async (_meta, call) => (traced = await call()));

    const res = await run();

    expect(mockCalculateCost).toHaveBeenCalledWith("gpt-6-luna", 300, 0, 600, 100);
    expect(res.inferenceOutputTokens).toBe(7);
    expect(res.inferenceCost).toBe(0.000042);
    const finish = (mockTracedDecision.mock.calls[0] as unknown[])[2] as (r: unknown) => {
      attributes: Record<string, unknown>;
    };
    const span = finish(traced).attributes;
    expect(span["llm.cost.total"]).toBe(res.inferenceCost);
    expect(span["gen_ai.usage.output_tokens"]).toBe(7);
    expect(span["decision.token_count.output"]).toBe(7);
  });

  it("keeps an unpriced call at 0 and out of the generic token-price fallback", async () => {
    mockCallDecisions.mockResolvedValueOnce(result(0.97, FAILURE_PROBS));
    mockCalculateCost.mockRejectedValueOnce(new Error("db down"));
    const res = await run();
    expect(res.inferenceCost).toBe(0);
    expect(res.skipCostFallback).toBe(true);
  });

  it("prices a billed failure once and hangs the cost on the rethrown error", async () => {
    const refused = Object.assign(
      new Error('OpenAI decisions refused to answer question "label"'),
      {
        usage: USAGE,
      },
    );
    mockCallDecisions.mockRejectedValueOnce(refused);

    const err = await run().catch((e: unknown) => e);

    expect(err).toBe(refused);
    expect(decisionsCostFromError(err)).toBe(0.000042);
    expect(mockCalculateCost).toHaveBeenCalledTimes(1);
  });

  it("rethrows a failed call with no usage unpriced", async () => {
    mockCallDecisions.mockRejectedValueOnce(new Error("OpenAI decisions returned 401"));
    const err = await run().catch((e: unknown) => e);
    expect((err as Error).message).toBe("OpenAI decisions returned 401");
    expect(decisionsCostFromError(err)).toBeNull();
    expect(mockCalculateCost).not.toHaveBeenCalled();
  });
});
