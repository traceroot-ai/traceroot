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
import { decisionFinding } from "./decision-result.js";
import { callSystemOne } from "./typesafe-client.js";
import { tracedSystemOne } from "./traced-system-one.js";

export const JEV_DEFAULT_MODEL_ID = ADAPTER_MODELS[LLMAdapter.TYPESAFE]![0].id;

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

  return {
    ...decisionFinding(result.answers.gate.noul, result.answers.label),
    // Priced from the token counts by the calculateCost fallback.
    inferenceCost: 0,
    inferenceInputTokens: result.usage.inputTokens,
    inferenceOutputTokens: result.usage.outputTokens,
    inferenceSource: "byok",
    inferenceModel: model,
    inferenceProvider: LLMAdapter.TYPESAFE,
  };
}
