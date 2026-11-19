/**
 * Turns a decision model's gate and label answers into a detector finding.
 * Shared by every decision backend (Jev, the OpenAI Decisions API): neither
 * writes a rationale, so the summary carries the category and probabilities.
 */

import type { EvalResult } from "./sandbox-eval.js";
import { JEV_NONE, JEV_OTHER } from "./jev-templates.js";

export const DECISION_GATE_THRESHOLD = 0.5;
const OTHER_LABEL = "unlisted problem";
const NO_RATIONALE = "; no written rationale.";

/** Category ids are snake_case words, so reading them out needs no label map. */
function displayCategory(name: string): string {
  return name === JEV_OTHER ? OTHER_LABEL : name.replace(/_/g, " ");
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** Non-`none` options, most likely first; ties keep the order they were asked in. */
function rankCategories(probabilities: Record<string, number>) {
  return Object.entries(probabilities)
    .filter(([name]) => name !== JEV_NONE)
    .map(([name, p]) => ({ name, p }))
    .sort((a, b) => b.p - a.p);
}

export function decisionFinding(
  gate: number,
  label: { choice: string; confidence: number; probabilities: Record<string, number> },
): Pick<EvalResult, "identified" | "summary" | "data"> {
  const identified = gate >= DECISION_GATE_THRESHOLD;

  const ranked = rankCategories(label.probabilities);
  const top = ranked[0];
  const next = ranked[1];
  // The gate fired but the label picked none: name no category.
  const unclear = label.choice === JEV_NONE;

  // Rendered verbatim in the findings table, which truncates at 100 characters.
  const summary = !identified
    ? `No problem found (${percent(gate)} chance of one).`
    : unclear
      ? `Problem found (${percent(gate)} likely), category unclear` + NO_RATIONALE
      : `${sentenceCase(displayCategory(top.name))} (${percent(top.p)} likely)` +
        (next ? `; runner-up: ${displayCategory(next.name)} (${percent(next.p)})` : "") +
        NO_RATIONALE;

  return {
    identified,
    summary,
    data: {
      category: unclear ? null : top.name,
      probabilities: label.probabilities,
      confidence: label.confidence,
      gate,
    },
  };
}
