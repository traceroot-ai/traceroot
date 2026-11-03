/**
 * Compile a detector into the two Decisions API questions answered in one
 * request: `gate` (predicate) decides whether the detector fires, and `label`
 * (choice) names the hidden category. Same questions and categories as Jev
 * (jev-compile.ts), in the Decisions API's string-only shape.
 *
 * The detector prompt is only ever the VALUE of `detector_criteria` in the
 * `input_json` data, never part of an instruction, so nothing in it can
 * rewrite the question.
 */

import type { JsonValue } from "./typesafe-client.js";
import type {
  ChoiceQuestion,
  DecisionsInput,
  PredicateQuestion,
} from "./openai-decisions-client.js";
import { JEV_GATE_CRITERIA, JEV_GATE_QUESTION, JEV_LABEL_QUESTION } from "./jev-compile.js";
import {
  JEV_NONE,
  JEV_NONE_CATEGORY,
  JEV_OTHER,
  JEV_OTHER_CATEGORY,
  JEV_PROBLEM,
  JEV_PROBLEM_CATEGORY,
  getJevTemplateCategories,
  type JevCategory,
} from "./jev-templates.js";

// Predicates take no criteria, so the yes/no meaning goes in the instructions.
export const DECISIONS_GATE_INSTRUCTIONS = `${JEV_GATE_QUESTION} Yes: ${JEV_GATE_CRITERIA.true} No: ${JEV_GATE_CRITERIA.false}`;

function description(category: JevCategory): string {
  return `${category.what} Not for: ${category.not_for}`;
}

export function compileDecisionsQuestions(input: { template: string | null }): {
  gate: PredicateQuestion;
  label: ChoiceQuestion;
} {
  const templateCategories = getJevTemplateCategories(input.template);
  // Options in the order sent: the categories, then `other` (if offered), then `none`.
  const categories: [string, JevCategory][] = templateCategories
    ? [
        ...Object.entries(templateCategories),
        [JEV_OTHER, JEV_OTHER_CATEGORY],
        [JEV_NONE, JEV_NONE_CATEGORY],
      ]
    : [
        [JEV_PROBLEM, JEV_PROBLEM_CATEGORY],
        [JEV_NONE, JEV_NONE_CATEGORY],
      ];

  return {
    gate: { type: "predicate", instructions: DECISIONS_GATE_INSTRUCTIONS },
    label: {
      type: "choice",
      instructions: JEV_LABEL_QUESTION,
      choices: categories.map(([value, category]) => ({
        value,
        description: description(category),
      })),
    },
  };
}

/** The projected trace (buildJevState) and the detector prompt, as the data both questions read. */
export function compileDecisionsInput(input: {
  prompt: string;
  state: { trace: JsonValue };
}): DecisionsInput {
  const data = { ...input.state, detector_criteria: input.prompt };
  return [{ role: "user", content: [{ type: "input_json", data }] }];
}
