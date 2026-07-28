import { describe, it, expect } from "vitest";
import { evaluateRuleDetector, type RuleConfig } from "../rule-eval.js";

const missingDataConfig: RuleConfig = {
  match: "any",
  conditions: [
    { field: "input", op: "is_empty" },
    { field: "output", op: "is_empty" },
  ],
};

describe("evaluateRuleDetector", () => {
  it("flags a span with empty output", () => {
    const spansJsonl = [
      JSON.stringify({ span_id: "s1", input: "hello", output: "world" }),
      JSON.stringify({ span_id: "s2", input: "hi", output: "" }),
    ].join("\n");

    const result = evaluateRuleDetector({ spansJsonl, ruleConfig: missingDataConfig });

    expect(result.identified).toBe(true);
    expect(result.summary).toContain("s2");
    expect(result.data.spanId).toBe("s2");
  });

  it("flags a span with null/missing input", () => {
    const spansJsonl = JSON.stringify({ span_id: "s1", input: null, output: "ok" });
    const result = evaluateRuleDetector({ spansJsonl, ruleConfig: missingDataConfig });
    expect(result.identified).toBe(true);
  });

  it("returns identified=false when no span matches", () => {
    const spansJsonl = [
      JSON.stringify({ span_id: "s1", input: "a", output: "b" }),
      JSON.stringify({ span_id: "s2", input: "c", output: "d" }),
    ].join("\n");

    const result = evaluateRuleDetector({ spansJsonl, ruleConfig: missingDataConfig });
    expect(result.identified).toBe(false);
    expect(result.data).toEqual({});
  });

  it("supports match: all (AND across conditions)", () => {
    const config: RuleConfig = {
      match: "all",
      conditions: [
        { field: "input", op: "is_empty" },
        { field: "output", op: "is_empty" },
      ],
    };
    const onlyInputEmpty = JSON.stringify({ span_id: "s1", input: "", output: "has data" });
    expect(
      evaluateRuleDetector({ spansJsonl: onlyInputEmpty, ruleConfig: config }).identified,
    ).toBe(false);

    const bothEmpty = JSON.stringify({ span_id: "s1", input: "", output: null });
    expect(evaluateRuleDetector({ spansJsonl: bothEmpty, ruleConfig: config }).identified).toBe(
      true,
    );
  });

  it("supports dot-path field access", () => {
    const config: RuleConfig = {
      conditions: [{ field: "attributes.tokens", op: "greater_than", value: 1000 }],
    };
    const spansJsonl = JSON.stringify({ span_id: "s1", attributes: { tokens: 5000 } });
    expect(evaluateRuleDetector({ spansJsonl, ruleConfig: config }).identified).toBe(true);
  });

  it("skips malformed JSON lines without throwing", () => {
    const spansJsonl = ["not json", JSON.stringify({ span_id: "s1", input: "", output: "" })].join(
      "\n",
    );
    const result = evaluateRuleDetector({ spansJsonl, ruleConfig: missingDataConfig });
    expect(result.identified).toBe(true);
  });

  it("errors gracefully when ruleConfig is missing/empty", () => {
    const result = evaluateRuleDetector({ spansJsonl: "{}", ruleConfig: null });
    expect(result.identified).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
