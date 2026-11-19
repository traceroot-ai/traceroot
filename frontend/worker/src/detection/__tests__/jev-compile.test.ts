import { describe, it, expect } from "vitest";
import {
  JEV_GATE_CRITERIA,
  JEV_GATE_QUESTION,
  JEV_LABEL_QUESTION,
  compileJevQuestions,
} from "../jev-compile.js";
import { JEV_TEMPLATE_CATEGORIES } from "../jev-templates.js";

const FAILURE_PROMPT =
  "Flag traces where a tool call fails and the agent continues as if it succeeded.";

describe("compileJevQuestions", () => {
  it("builds a Noul gate and a Choice label with the prompt under detector_criteria", () => {
    const questions = compileJevQuestions({ prompt: FAILURE_PROMPT, template: "failure" });
    expect(questions.gate).toEqual({
      type: "noul",
      instructions: { detector_criteria: FAILURE_PROMPT, question: JEV_GATE_QUESTION },
      criteria: { true: JEV_GATE_CRITERIA.true, false: JEV_GATE_CRITERIA.false },
    });
    expect(questions.label.type).toBe("choice");
    expect(questions.label.instructions).toEqual({
      detector_criteria: FAILURE_PROMPT,
      question: JEV_LABEL_QUESTION,
    });
  });

  it("offers template categories, then other, then none", () => {
    const questions = compileJevQuestions({ prompt: FAILURE_PROMPT, template: "failure" });
    const expected = [...Object.keys(JEV_TEMPLATE_CATEGORIES.failure), "other", "none"];
    expect(Object.keys(questions.label.criteria)).toEqual(expected);
    expect(questions.label.criteria.tool_error).toEqual(JEV_TEMPLATE_CATEGORIES.failure.tool_error);
  });

  it.each([["blank"], [null], ["intent"]])(
    "gives a %s template {problem, none} with no other",
    (template) => {
      const questions = compileJevQuestions({ prompt: "custom", template });
      expect(Object.keys(questions.label.criteria)).toEqual(["problem", "none"]);
    },
  );
});
