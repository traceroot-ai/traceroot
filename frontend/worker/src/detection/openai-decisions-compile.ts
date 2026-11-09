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

/**
 * The API's `input_json` limits: "32 container levels, 10,000 values, and 256
 * KiB of compact UTF-8 JSON". The docs don't say what a value is, so every
 * container and scalar counts as one, with headroom under the 10,000.
 */
export const DECISIONS_MAX_DEPTH = 32;
export const DECISIONS_MAX_VALUES = 9_500;
export const DECISIONS_MAX_BYTES = 256 * 1024;

type JsonObject = { [key: string]: JsonValue };

function isContainer(value: JsonValue): value is JsonValue[] | JsonObject {
  return value !== null && typeof value === "object";
}

function countValues(value: JsonValue): number {
  if (!isContainer(value)) return 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce<number>((n, child) => n + countValues(child), 1);
}

/** Containers past DECISIONS_MAX_DEPTH levels become their compact JSON text. */
function flattenBelow(value: JsonValue, level: number, collapsed: { n: number }): JsonValue {
  if (!isContainer(value)) return value;
  if (level > DECISIONS_MAX_DEPTH) {
    collapsed.n++;
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return value.map((v) => flattenBelow(v, level + 1, collapsed));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, flattenBelow(v, level + 1, collapsed)]),
  );
}

/**
 * Fit the projected trace to the API's depth and value limits, which the
 * character budget does not bound. Containers past the depth limit, then the
 * largest structured span fields (input, output, metadata) while the value
 * count is over, are sent as their compact JSON text: nothing is dropped,
 * only unparsed. Throws when no span field is left to collapse.
 */
export function fitDecisionsState(state: { trace: JsonValue }): {
  state: { trace: JsonValue };
  collapsedContainers: number;
} {
  const collapsed = { n: 0 };
  // The state's root is the data's root (level 1); detector_criteria is a string.
  const trace = flattenBelow(state.trace, 2, collapsed);

  // One value for the data root and one for detector_criteria.
  let total = countValues(trace) + 2;
  if (total > DECISIONS_MAX_VALUES && isContainer(trace) && !Array.isArray(trace)) {
    const spans = Array.isArray(trace.spans) ? trace.spans : [];
    const fields: { span: JsonObject; key: string; count: number }[] = [];
    for (const span of spans) {
      if (!isContainer(span) || Array.isArray(span)) continue;
      for (const [key, value] of Object.entries(span)) {
        if (isContainer(value)) fields.push({ span, key, count: countValues(value) });
      }
    }
    fields.sort((a, b) => b.count - a.count);
    for (const field of fields) {
      if (total <= DECISIONS_MAX_VALUES) break;
      field.span[field.key] = JSON.stringify(field.span[field.key]);
      total -= field.count - 1;
      collapsed.n++;
    }
  }
  if (total > DECISIONS_MAX_VALUES) {
    throw new Error(
      `Decisions input has ${total} JSON values, over the ${DECISIONS_MAX_VALUES} limit, ` +
        `even with every structured span field sent as text`,
    );
  }
  return { state: { trace }, collapsedContainers: collapsed.n };
}

/**
 * The projected trace (buildJevState, then fitDecisionsState) and the
 * detector prompt, as the data both questions read. Throws when the data is
 * over the API's size limit, rather than sending a request that gets a 400.
 */
export function compileDecisionsInput(input: {
  prompt: string;
  state: { trace: JsonValue };
}): DecisionsInput {
  const data = { ...input.state, detector_criteria: input.prompt };
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > DECISIONS_MAX_BYTES) {
    throw new Error(
      `Decisions input is ${bytes} bytes of JSON, over the ${DECISIONS_MAX_BYTES}-byte limit`,
    );
  }
  return [{ role: "user", content: [{ type: "input_json", data }] }];
}
