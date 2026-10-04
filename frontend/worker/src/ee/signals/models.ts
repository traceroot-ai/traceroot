import { Type } from "@earendil-works/pi-ai";
import type { Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { PrismaClient } from "@traceroot/core";
import {
  fetchProviderConfig,
  resolvePiModel,
  type ProviderModelConfig,
} from "@traceroot/core/model-resolver";
import { ADAPTER_DEFAULT_BASE_URL, LLMAdapter } from "@traceroot/core/llm-providers";
import { tracedComplete } from "../../detection/traced-complete.js";
import { callSystemOne, usageFromError } from "../../detection/typesafe-client.js";
import { JEV_DEFAULT_MODEL_ID } from "../../detection/jev-eval.js";
import { ASSIGN_CHAT_MODEL_ID, CHAT_TIMEOUT_MS, JEV_TIMEOUT_MS } from "./config.js";
import {
  ASSIGN_SYSTEM,
  VALIDATE_SYSTEM,
  WRITER_SYSTEM,
  assignUserText,
  jevAssignQuestion,
  jevValidateQuestions,
  validateUserText,
  writerUserText,
} from "./prompts.js";
import type { AssignmentModels, ChatAssignAnswer, ModelUsage, SignalText } from "./types.js";

const signalTextSchema = Type.Object(
  {
    title: Type.String({ description: "Short title naming the defect and its mechanism" }),
    covers: Type.String({ description: "Which hits belong to this signal" }),
    excludes: Type.String({ description: "Nearby defects that need a different fix" }),
  },
  { additionalProperties: false },
);

const ASSIGN_TOOL: Tool = {
  name: "submit_assignment",
  description: "Submit the assignment. You MUST call this tool. Do not respond with plain text.",
  parameters: Type.Object(
    {
      choice: Type.String({ description: "The candidate id, or 'none'" }),
      reason: Type.String({ description: "One sentence on why" }),
      new_signal: Type.Union([Type.Null(), signalTextSchema], {
        description: "The new signal when choice is 'none', otherwise null",
      }),
    },
    { additionalProperties: false },
  ),
};

const WRITE_TOOL: Tool = {
  name: "submit_signal",
  description: "Submit the new signal. You MUST call this tool. Do not respond with plain text.",
  parameters: signalTextSchema,
};

const VALIDATE_TOOL: Tool = {
  name: "submit_validation",
  description: "Submit one answer per hit, in order. You MUST call this tool.",
  parameters: Type.Object(
    { accepted: Type.Array(Type.Boolean(), { description: "true if the criteria cover hit i" }) },
    { additionalProperties: false },
  ),
};

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function parseSignalText(v: unknown): SignalText | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!nonEmptyString(o.title) || !nonEmptyString(o.covers) || typeof o.excludes !== "string") {
    return null;
  }
  return { title: o.title.trim(), covers: o.covers.trim(), excludes: o.excludes.trim() };
}

export function parseAssignAnswer(args: Record<string, unknown>): ChatAssignAnswer | null {
  if (!nonEmptyString(args.choice)) return null;
  const choice = args.choice.trim();
  const newSignal = args.new_signal == null ? null : parseSignalText(args.new_signal);
  // A malformed new signal is dropped; the writer produces one instead.
  return { choice, reason: typeof args.reason === "string" ? args.reason : "", newSignal };
}

/**
 * Exactly one yes/no per text, or null (malformed). A missing answer is not a
 * "no": read as one, a single [true] for several texts would accept the new hit
 * and reject every other signal, passing validation it never ran.
 */
export function exactAnswers(answers: unknown, count: number): boolean[] | null {
  if (!Array.isArray(answers) || answers.length !== count) return null;
  return answers.every((a) => typeof a === "boolean") ? answers : null;
}

/** Chat calls on the deployment's OpenAI key. Every call's usage is pushed to `usage`. */
export function createChatModels(apiKey: string, usage: ModelUsage[]): AssignmentModels["chat"] {
  // Built through the BYOK branch only to get an OpenAI model object with the
  // right protocol; the key is the deployment's own, and usage is recorded as
  // system usage.
  const model = resolvePiModel(ASSIGN_CHAT_MODEL_ID, {
    adapter: LLMAdapter.OPENAI,
    key: apiKey,
    baseUrl: null,
    config: null,
  });

  async function call<T>(
    systemPrompt: string,
    userText: string,
    tool: Tool,
    parse: (args: Record<string, unknown>) => T | null,
  ): Promise<T> {
    const messages: Message[] = [{ role: "user", content: userText, timestamp: Date.now() }];
    let lastError = "no tool call";
    // One retry when the model answers in text or with malformed arguments.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
      timer.unref?.();
      try {
        const response = await tracedComplete(
          model,
          { systemPrompt, messages, tools: [tool] },
          // The benchmark ran this model at the API's default effort; say so
          // explicitly so a registry update cannot turn reasoning off.
          { apiKey, signal: controller.signal, reasoningEffort: "medium" },
        );
        if (controller.signal.aborted || response.stopReason === "aborted") {
          throw new Error(`${tool.name} timed out after ${CHAT_TIMEOUT_MS}ms`);
        }
        usage.push({
          model: response.model ?? model.id,
          provider: response.provider ?? model.provider,
          isByok: false,
          inputTokens: response.usage?.input ?? 0,
          outputTokens: response.usage?.output ?? 0,
          cost: response.usage?.cost?.total ?? 0,
        });
        if (response.stopReason === "error") {
          throw new Error(`${tool.name}: ${response.errorMessage || "provider error"}`);
        }
        const toolCall = response.content.find(
          (c): c is ToolCall => c.type === "toolCall" && c.name === tool.name,
        );
        const parsed = toolCall ? parse(toolCall.arguments as Record<string, unknown>) : null;
        if (parsed !== null) return parsed;
        lastError = toolCall ? "malformed tool arguments" : "no tool call";
        messages.push(response);
        messages.push({
          role: "user",
          content: `You must call ${tool.name} with every field filled in. Do not respond with text.`,
          timestamp: Date.now(),
        });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${ASSIGN_CHAT_MODEL_ID} ${tool.name}: ${lastError}`);
  }

  return {
    assign: (material, candidates) =>
      call(ASSIGN_SYSTEM, assignUserText(material, candidates), ASSIGN_TOOL, parseAssignAnswer),
    write: (material, candidates) =>
      call(WRITER_SYSTEM, writerUserText(material, candidates), WRITE_TOOL, parseSignalText),
    validate: (covers, excludes, texts) =>
      call(VALIDATE_SYSTEM, validateUserText(covers, excludes, texts), VALIDATE_TOOL, (args) =>
        exactAnswers(args.accepted, texts.length),
      ),
  };
}

/** Jev calls on the workspace's own TypeSafe key. Usage is recorded as BYOK. */
export function createJevModels(
  config: ProviderModelConfig,
  usage: ModelUsage[],
): NonNullable<AssignmentModels["jev"]> {
  const baseUrl = config.baseUrl || ADAPTER_DEFAULT_BASE_URL[LLMAdapter.TYPESAFE];
  const model = JEV_DEFAULT_MODEL_ID;
  const record = (u: { inputTokens: number; outputTokens: number } | null) => {
    if (u) usage.push({ model, provider: LLMAdapter.TYPESAFE, isByok: true, cost: 0, ...u });
  };

  async function ask<Q extends Parameters<typeof callSystemOne>[0]["questions"]>(
    state: Record<string, string>,
    questions: Q,
  ) {
    try {
      const result = await callSystemOne({
        apiKey: config.key,
        baseUrl,
        model,
        state,
        questions,
        deadlineMs: JEV_TIMEOUT_MS,
      });
      record(result.usage);
      return result.answers;
    } catch (err) {
      // TypeSafe bills a response we reject; keep its tokens findable.
      record(usageFromError(err));
      throw err;
    }
  }

  return {
    async assign(material, candidates) {
      const answers = await ask({ hit: material }, jevAssignQuestion(candidates));
      return { choice: answers.signal.choice, probabilities: answers.signal.probabilities };
    },
    async validate(covers, excludes, texts) {
      const state: Record<string, string> = {
        criteria: `covers: ${covers}\nexcludes: ${excludes}`,
      };
      texts.forEach((t, i) => (state[`hit_${i}`] = t));
      const answers = await ask(state, jevValidateQuestions(texts.length));
      return texts.map((_, i) => answers[`hit_${i}`].noul >= 0.5);
    },
  };
}

/** The workspace's enabled TypeSafe provider, or null. Oldest first when there are several. */
export async function findJevProvider(
  db: Pick<PrismaClient, "modelProvider">,
  workspaceId: string,
): Promise<ProviderModelConfig | null> {
  const rows = await db.modelProvider.findMany({
    where: { workspaceId, enabled: true, adapter: LLMAdapter.TYPESAFE },
    select: { provider: true },
    orderBy: { createTime: "asc" },
  });
  for (const row of rows) {
    const config = await fetchProviderConfig(workspaceId, row.provider);
    if (config) return config;
  }
  return null;
}
