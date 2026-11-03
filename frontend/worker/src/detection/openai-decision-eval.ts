/**
 * OpenAI Decisions detector backend: judges one trace with the Decisions API
 * instead of a chat LLM, for BYOK detectors pinned to a decision alias such as
 * `gpt-6-luna-decisions`. The alias is only what the detector stores; the API
 * model (`gpt-6-luna`) is what is called, priced and traced. Failures throw;
 * the sandbox-eval dispatch turns them into an error EvalResult.
 */

import { calculateCost } from "@traceroot/core";
import {
  ADAPTER_DEFAULT_BASE_URL,
  LLMAdapter,
  decisionModelAlias,
} from "@traceroot/core/llm-providers";
import type { ProviderModelConfig } from "@traceroot/core/model-resolver";
import type { DetectorConfig, EvalResult } from "./sandbox-eval.js";
import { buildJevState } from "./jev-state.js";
import { decisionFinding } from "./decision-result.js";
import { compileDecisionsInput, compileDecisionsQuestions } from "./openai-decisions-compile.js";
import {
  callDecisions,
  decisionsUsageFromError,
  type DecisionsUsage,
} from "./openai-decisions-client.js";
import { tracedDecision } from "./traced-system-one.js";

/** The API model a detector's decision alias calls, or null if it names none. */
export function openAIDecisionModel(detectionModel: string | null | undefined): string | null {
  const alias = decisionModelAlias(detectionModel);
  return alias?.adapter === LLMAdapter.OPENAI ? alias.model : null;
}

/**
 * Cost in USD of one Decisions call. `input_tokens` includes the cache reads
 * and writes, so they are split out and priced at their own rates. Output is
 * not charged, so it is priced at zero whatever count the response reports.
 * Null when the price lookup fails.
 */
export async function decisionsCost(model: string, usage: DecisionsUsage): Promise<number | null> {
  const uncached = usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens;
  try {
    return await calculateCost(model, uncached, 0, usage.cachedTokens, usage.cacheWriteTokens);
  } catch (err) {
    console.error(`[Detector] Failed to price decisions usage for model ${model}:`, err);
    return null;
  }
}

/** The cost runOpenAIDecisionDetection priced a billed failure at, or null. */
export function decisionsCostFromError(err: unknown): number | null {
  const cost = err instanceof Error ? (err as { cost?: unknown }).cost : undefined;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/**
 * Span attributes for the billed usage. Tokens are the reported counts; the
 * cost is the one the detector run records, so the self-trace's cost matches
 * it instead of list-pricing output. With no cost, ingest prices the tokens.
 */
function usageAttributes(usage: DecisionsUsage, cost: number | null): Record<string, number> {
  return {
    "gen_ai.usage.input_tokens": usage.inputTokens,
    "gen_ai.usage.output_tokens": usage.outputTokens,
    "gen_ai.usage.cache_read.input_tokens": usage.cachedTokens,
    "gen_ai.usage.cache_creation.input_tokens": usage.cacheWriteTokens,
    "decision.token_count.input": usage.inputTokens,
    "decision.token_count.output": usage.outputTokens,
    ...(cost !== null ? { "llm.cost.total": cost } : {}),
  };
}

export async function runOpenAIDecisionDetection(params: {
  spansJsonl: string;
  detector: DetectorConfig;
  providerConfig: ProviderModelConfig;
  /** Total budget for the Decisions call, retries included. */
  timeoutMs: number;
}): Promise<EvalResult> {
  const { spansJsonl, detector, providerConfig, timeoutMs } = params;
  const model = openAIDecisionModel(detector.detectionModel);
  if (!model) {
    throw new Error(`Model "${detector.detectionModel}" is not an OpenAI decision model`);
  }
  const baseUrl = providerConfig.baseUrl || ADAPTER_DEFAULT_BASE_URL[LLMAdapter.OPENAI];

  const questions = compileDecisionsQuestions({ template: detector.template ?? null });
  const jevState = buildJevState(spansJsonl);
  const input = compileDecisionsInput({ prompt: detector.prompt, state: jevState.state });

  const result = await tracedDecision(
    {
      name: `decisions ${model}`,
      model,
      input: {
        questions,
        state_preview: JSON.stringify(jevState.state),
        state_stats: jevState.stats,
      },
      attributes: {
        "decision.system": "openai",
        "decision.provider": "openai",
        "decision.model_name": model,
      },
    },
    // Priced once, inside the call, so the span and the run record one cost.
    async () => {
      try {
        const decided = await callDecisions({
          apiKey: providerConfig.key,
          baseUrl,
          model,
          input,
          questions,
          deadlineMs: timeoutMs,
        });
        return { ...decided, cost: await decisionsCost(model, decided.usage) };
      } catch (err) {
        const usage = decisionsUsageFromError(err);
        const cost = usage ? await decisionsCost(model, usage) : null;
        throw err instanceof Error && cost !== null ? Object.assign(err, { cost }) : err;
      }
    },
    (done) => ({
      model: done.model,
      // The response's model, when it names one, is the identity on both keys.
      attributes: {
        ...usageAttributes(done.usage, done.cost),
        "decision.model_name": done.model ?? model,
      },
      output: done.answers,
    }),
    (err) => {
      const usage = decisionsUsageFromError(err);
      return usage ? usageAttributes(usage, decisionsCostFromError(err)) : null;
    },
  );

  return {
    ...decisionFinding(result.answers.gate.probability, result.answers.label),
    // 0 leaves an unpriced call to the run processor's token-count fallback.
    inferenceCost: result.cost ?? 0,
    inferenceInputTokens: result.usage.inputTokens,
    inferenceOutputTokens: result.usage.outputTokens,
    inferenceSource: "byok",
    inferenceModel: model,
    inferenceProvider: LLMAdapter.OPENAI,
  };
}
