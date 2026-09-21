/**
 * Jev detector backend: judges one trace with TypeSafe's System One instead of
 * a chat LLM, for detectors whose BYOK provider uses a decision adapter. Jev
 * writes no rationale, so the summary carries the category and probabilities.
 * Failures throw; the sandbox-eval dispatch turns them into an error EvalResult.
 */

import {
  ADAPTER_DEFAULT_BASE_URL,
  ADAPTER_MODELS,
  LLMAdapter,
} from "@traceroot/core/llm-providers";
import type { ProviderModelConfig } from "@traceroot/core/model-resolver";
import type { DetectorConfig, EvalResult } from "./sandbox-eval.js";
import { buildJevState } from "./jev-state.js";
import { compileJevQuestions } from "./jev-compile.js";
import { JEV_NONE, JEV_OTHER } from "./jev-templates.js";
import { callSystemOne } from "./typesafe-client.js";
import { tracedSystemOne } from "./traced-system-one.js";

export const JEV_DEFAULT_MODEL_ID = ADAPTER_MODELS[LLMAdapter.TYPESAFE]![0].id;
export const JEV_GATE_THRESHOLD = 0.5;
const OTHER_LABEL = "unlisted problem";

function displayCategory(name: string): string {
  return name === JEV_OTHER ? OTHER_LABEL : name;
}

/** Non-`none` options, most likely first; ties keep the order they were asked in. */
function rankCategories(probabilities: Record<string, number>) {
  return Object.entries(probabilities)
    .filter(([name]) => name !== JEV_NONE)
    .map(([name, p]) => ({ name, p }))
    .sort((a, b) => b.p - a.p);
}

export async function runJevDetection(params: {
  spansJsonl: string;
  detector: DetectorConfig;
  providerConfig: ProviderModelConfig;
  /** Total budget for the System One call, retries included. */
  timeoutMs: number;
}): Promise<EvalResult> {
  const { spansJsonl, detector, providerConfig, timeoutMs } = params;
  const model = detector.detectionModel || JEV_DEFAULT_MODEL_ID;
  const baseUrl = providerConfig.baseUrl || ADAPTER_DEFAULT_BASE_URL[LLMAdapter.TYPESAFE];

  const questions = compileJevQuestions({
    prompt: detector.prompt,
    template: detector.template ?? null,
  });

  const jevState = buildJevState(spansJsonl);
  const result = await tracedSystemOne(
    {
      model,
      questions,
      statePreview: JSON.stringify(jevState.state),
      stateStats: jevState.stats,
    },
    () =>
      callSystemOne({
        apiKey: providerConfig.key,
        baseUrl,
        model,
        state: jevState.state,
        questions,
        deadlineMs: timeoutMs,
      }),
  );

  const gate = result.answers.gate.noul;
  const label = result.answers.label;
  const identified = gate >= JEV_GATE_THRESHOLD;

  const ranked = rankCategories(label.probabilities);
  const top = ranked[0];
  const next = ranked[1];
  // The gate fired but the label picked none: name no category.
  const unclear = label.choice === JEV_NONE;
  const confidence =
    top.name === label.choice ? `, label confidence ${label.confidence.toFixed(2)}` : "";

  const summary = !identified
    ? `Jev: no problem found (P=${gate.toFixed(2)} that the trace exhibits one).`
    : unclear
      ? `Jev: problem found (P=${gate.toFixed(2)}), category unclear` +
        "; no written rationale — verify against the trace."
      : `Jev: ${displayCategory(top.name)} (P=${top.p.toFixed(2)}${confidence})` +
        (next ? `; next: ${displayCategory(next.name)} (${next.p.toFixed(2)})` : "") +
        "; no written rationale — verify against the trace.";

  return {
    identified,
    summary,
    data: {
      category: unclear ? null : top.name,
      probabilities: label.probabilities,
      confidence: label.confidence,
      gate,
    },
    // Priced from the token counts by the calculateCost fallback.
    inferenceCost: 0,
    inferenceInputTokens: result.usage.inputTokens,
    inferenceOutputTokens: result.usage.outputTokens,
    inferenceSource: "byok",
    inferenceModel: model,
    inferenceProvider: LLMAdapter.TYPESAFE,
  };
}
