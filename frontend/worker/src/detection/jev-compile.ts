/**
 * Compile a detector into the two System One questions Jev answers in one
 * request: `gate` (Noul) decides whether the detector fires, and `label`
 * (Choice) names the hidden category (jev-templates.ts).
 *
 * The detector prompt is only ever the VALUE of `detector_criteria`, never
 * interpolated into a string, so nothing in it can rewrite the question.
 */

import type { ChoiceQuestion, NoulQuestion } from "./typesafe-client.js";
import {
  JEV_NONE,
  JEV_NONE_CATEGORY,
  JEV_OTHER,
  JEV_OTHER_CATEGORY,
  JEV_PROBLEM,
  JEV_PROBLEM_CATEGORY,
  getJevTemplateCategories,
} from "./jev-templates.js";

export const JEV_GATE_QUESTION =
  "Does `trace` exhibit any problem described in `detector_criteria`?";
export const JEV_LABEL_QUESTION = "Which category best describes the problem `trace` exhibits?";

export const JEV_GATE_CRITERIA = {
  true: "The trace exhibits at least one problem described in detector_criteria.",
  false: "The trace exhibits none of the problems described in detector_criteria.",
} as const;

export function compileJevQuestions(input: { prompt: string; template: string | null }): {
  gate: NoulQuestion;
  label: ChoiceQuestion;
} {
  const templateCategories = getJevTemplateCategories(input.template);
  // Options in the order sent: the categories, then `other` (if offered), then `none`.
  const labelCriteria: ChoiceQuestion["criteria"] = templateCategories
    ? { ...templateCategories, [JEV_OTHER]: JEV_OTHER_CATEGORY, [JEV_NONE]: JEV_NONE_CATEGORY }
    : { [JEV_PROBLEM]: JEV_PROBLEM_CATEGORY, [JEV_NONE]: JEV_NONE_CATEGORY };

  return {
    gate: {
      type: "noul",
      instructions: { detector_criteria: input.prompt, question: JEV_GATE_QUESTION },
      criteria: { true: JEV_GATE_CRITERIA.true, false: JEV_GATE_CRITERIA.false },
    },
    label: {
      type: "choice",
      instructions: { detector_criteria: input.prompt, question: JEV_LABEL_QUESTION },
      criteria: labelCriteria,
    },
  };
}
