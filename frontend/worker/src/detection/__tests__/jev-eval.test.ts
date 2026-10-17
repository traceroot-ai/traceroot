import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCallSystemOne } = vi.hoisted(() => ({ mockCallSystemOne: vi.fn() }));

vi.mock("../typesafe-client.js", () => ({ callSystemOne: mockCallSystemOne }));

import { runJevDetection, JEV_DEFAULT_MODEL_ID } from "../jev-eval.js";
import type { DetectorConfig } from "../sandbox-eval.js";

const DETECTOR: DetectorConfig = {
  id: "det-jev",
  name: "failure detector",
  prompt: "Flag traces where a tool call fails and the agent continues.",
  outputSchema: [],
  detectionModel: "jev-1.13.0",
  detectionProvider: "my-typesafe",
  detectionSource: "byok",
  template: "failure",
};

const PROVIDER_CONFIG = {
  adapter: "typesafe",
  key: "ts-secret-key",
  baseUrl: null,
  config: null,
};

const SPANS =
  '{"trace_id":"t-1","span_id":"s1","name":"agent.run","input":"{\\"task\\":\\"weather\\"}"}\n' +
  '{"trace_id":"t-1","span_id":"s2","name":"tool.get_weather","status":"ERROR"}';

/** Failure-template probabilities (tool_error, silent_failure, loop, timeout, swallowed_error, other, none). */
const FAILURE_PROBS = {
  tool_error: 0.91,
  silent_failure: 0,
  loop: 0,
  timeout: 0.06,
  swallowed_error: 0.01,
  other: 0.01,
  none: 0.01,
};

function answers(gate: number, probabilities: Record<string, number>, confidence = 0.88) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return {
    model: "jev-1.13.0",
    answers: {
      gate: { type: "noul", noul: gate },
      label: { type: "choice", choice, confidence, probabilities },
    },
    usage: { inputTokens: 810, outputTokens: 63 },
  };
}

function run(overrides: Partial<Parameters<typeof runJevDetection>[0]> = {}) {
  return runJevDetection({
    spansJsonl: SPANS,
    detector: DETECTOR,
    providerConfig: PROVIDER_CONFIG,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function sentOptions() {
  return mockCallSystemOne.mock.calls[0][0];
}

describe("runJevDetection", () => {
  beforeEach(() => {
    mockCallSystemOne.mockReset();
  });

  it("fires on the gate and reports the top category, the runner-up and the usage", async () => {
    mockCallSystemOne.mockResolvedValueOnce(answers(0.97, FAILURE_PROBS));

    const result = await run();

    expect(result.identified).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.summary).toBe(
      "Tool error (91% likely); runner-up: timeout (6%); no written rationale.",
    );
    expect(result.data).toEqual({
      category: "tool_error",
      probabilities: FAILURE_PROBS,
      confidence: 0.88,
      gate: 0.97,
    });
    expect(result).toMatchObject({
      inferenceCost: 0,
      inferenceInputTokens: 810,
      inferenceOutputTokens: 63,
      inferenceSource: "byok",
      inferenceModel: "jev-1.13.0",
      inferenceProvider: "typesafe",
    });
  });

  it("sends the provider key and timeout, defaulting the model and base URL", async () => {
    mockCallSystemOne.mockResolvedValueOnce(answers(0.2, FAILURE_PROBS));

    const result = await run({ detector: { ...DETECTOR, detectionModel: null } });

    expect(sentOptions()).toMatchObject({
      apiKey: "ts-secret-key",
      baseUrl: "https://api.typesafe.ai/v1",
      model: JEV_DEFAULT_MODEL_ID,
      deadlineMs: 5_000,
    });
    expect(result.inferenceModel).toBe(JEV_DEFAULT_MODEL_ID);
  });

  it.each([
    [0.5, true],
    [0.49, false],
  ])("gate P=%s fires=%s", async (gate, fires) => {
    mockCallSystemOne.mockResolvedValueOnce(answers(gate, FAILURE_PROBS));

    const result = await run();

    expect(result.identified).toBe(fires);
    expect(result.data.gate).toBe(gate);
  });

  it("fires but names no category when the label's choice is none", async () => {
    const probs = { ...FAILURE_PROBS, tool_error: 0.03, timeout: 0.1, none: 0.85 };
    mockCallSystemOne.mockResolvedValueOnce(answers(0.6, probs));

    const result = await run();

    expect(result.identified).toBe(true);
    expect(result.data.category).toBeNull();
    expect(result.summary).toBe(
      "Problem found (60% likely), category unclear; no written rationale.",
    );
  });

  it("names the most likely category even when the label's choice is another", async () => {
    const body = answers(0.9, FAILURE_PROBS);
    body.answers.label.choice = "timeout";
    mockCallSystemOne.mockResolvedValueOnce(body);

    const result = await run();

    expect(result.data.category).toBe("tool_error");
    expect(result.summary).toBe(
      "Tool error (91% likely); runner-up: timeout (6%); no written rationale.",
    );
  });

  it("reports other as an unlisted problem", async () => {
    const probs = { ...FAILURE_PROBS, tool_error: 0.1, timeout: 0.02, other: 0.86 };
    mockCallSystemOne.mockResolvedValueOnce(answers(0.9, probs));

    const result = await run();

    expect(result.data.category).toBe("other");
    expect(result.summary).toBe(
      "Unlisted problem (86% likely); runner-up: tool error (10%); no written rationale.",
    );
  });

  it("asks {problem, none} for a blank detector and omits the runner-up", async () => {
    mockCallSystemOne.mockResolvedValueOnce(answers(0.8, { problem: 0.75, none: 0.25 }, 0.75));

    const result = await run({ detector: { ...DETECTOR, template: "blank" } });

    expect(Object.keys(sentOptions().questions.label.criteria)).toEqual(["problem", "none"]);
    expect(result.summary).toBe("Problem (75% likely); no written rationale.");
  });
});
