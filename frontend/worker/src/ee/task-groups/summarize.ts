import { Type } from "@earendil-works/pi-ai";
import type { Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import { resolvePiModel } from "@traceroot/core/model-resolver";
import { LLMAdapter } from "@traceroot/core/llm-providers";
import { tracedComplete } from "../../detection/traced-complete.js";
import {
  SUMMARY_INPUT_USD_PER_TOKEN,
  SUMMARY_MAX_CHARS,
  SUMMARY_MODEL_ID,
  SUMMARY_OUTPUT_USD_PER_TOKEN,
  SUMMARY_TIMEOUT_MS,
} from "./config.js";
import { SUMMARY_SYSTEM, summaryUserText } from "./prompts.js";

const SUMMARY_TOOL: Tool = {
  name: "submit_task_summary",
  description: "Submit the one-sentence task summary. You MUST call this tool.",
  parameters: Type.Object(
    {
      has_task: Type.Boolean({ description: "false when the run shows no discernible task" }),
      summary: Type.String({ description: "One sentence naming the kind of task" }),
    },
    { additionalProperties: false },
  ),
};

export interface SummaryResult {
  /** Null when the run shows no task. */
  summary: string | null;
  costUsd: number;
}

/** Normalize the model's sentence: one line, trimmed, bounded. Null if nothing is left. */
export function cleanSummary(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, SUMMARY_MAX_CHARS) : null;
}

export function parseSummaryArgs(args: Record<string, unknown>): { summary: string | null } | null {
  if (typeof args.has_task !== "boolean") return null;
  if (!args.has_task) return { summary: null };
  const summary = cleanSummary(args.summary);
  return summary ? { summary } : null;
}

/** The call's cost: the provider's figure when it gives one, else tokens at list price. */
export function callCost(usage?: {
  input?: number;
  output?: number;
  cost?: { total?: number };
}): number {
  const reported = usage?.cost?.total ?? 0;
  if (reported > 0) return reported;
  return (
    (usage?.input ?? 0) * SUMMARY_INPUT_USD_PER_TOKEN +
    (usage?.output ?? 0) * SUMMARY_OUTPUT_USD_PER_TOKEN
  );
}

export class UnusableSummaryError extends Error {}

export type Summarize = (runText: string) => Promise<SummaryResult>;

/** Summaries on the deployment's OpenAI key. */
export function createSummarizer(apiKey: string): Summarize {
  const model = resolvePiModel(SUMMARY_MODEL_ID, {
    adapter: LLMAdapter.OPENAI,
    key: apiKey,
    baseUrl: null,
    config: null,
  });
  return async (runText) => {
    const messages: Message[] = [
      { role: "user", content: summaryUserText(runText), timestamp: Date.now() },
    ];
    let cost = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
      timer.unref?.();
      try {
        const response = await tracedComplete(
          model,
          { systemPrompt: SUMMARY_SYSTEM, messages, tools: [SUMMARY_TOOL] },
          { apiKey, signal: controller.signal, reasoningEffort: "low" },
        );
        cost += callCost(response.usage);
        if (controller.signal.aborted || response.stopReason === "aborted") {
          throw new Error(`${SUMMARY_TOOL.name} timed out after ${SUMMARY_TIMEOUT_MS}ms`);
        }
        if (response.stopReason === "error") {
          throw new Error(`${SUMMARY_TOOL.name}: ${response.errorMessage || "provider error"}`);
        }
        const call = response.content.find(
          (c): c is ToolCall => c.type === "toolCall" && c.name === SUMMARY_TOOL.name,
        );
        const parsed = call ? parseSummaryArgs(call.arguments as Record<string, unknown>) : null;
        if (parsed) return { summary: parsed.summary, costUsd: cost };
        messages.push(response);
        messages.push({
          role: "user",
          content: `Call ${SUMMARY_TOOL.name} with every field filled in. Do not reply in text.`,
          timestamp: Date.now(),
        });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new UnusableSummaryError(`${SUMMARY_MODEL_ID} gave no usable summary`);
  };
}
