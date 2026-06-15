import { complete, getEnvApiKey } from "@earendil-works/pi-ai";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import {
  findByokKeyForPiProvider,
  fetchProviderConfig,
  resolvePiModel,
  type ProviderModelConfig,
} from "@traceroot/core/model-resolver";
import { buildSubmitResultTool, type SubmitResultInput } from "./submit-result-tool.js";

export interface DetectorConfig {
  id: string;
  name: string;
  prompt: string;
  outputSchema: Array<{ name: string; type: string }>;
  detectionModel?: string | null;
  detectionProvider?: string | null;
  detectionSource?: "system" | "byok" | null;
}

export interface EvalResult {
  identified: boolean;
  summary: string;
  data: Record<string, unknown>;
  error?: string;
  /** Sum of `response.usage.cost.total` (USD) across attempts; 0 on early-exit error paths. */
  inferenceCost: number;
  /** Sum of `response.usage.input` tokens across attempts. */
  inferenceInputTokens: number;
  /** Sum of `response.usage.output` tokens across attempts. */
  inferenceOutputTokens: number;
  /** Source attribution for billing — preserved on error paths so failures still attribute. */
  inferenceSource: "system" | "byok" | null;
  /** Model id reported by pi-ai (e.g. "claude-haiku-4-5"); null on early-exit error paths. */
  inferenceModel: string | null;
  /** Provider key reported by pi-ai (e.g. "anthropic"); null on early-exit error paths. */
  inferenceProvider: string | null;
}

const MAX_ATTEMPTS = 2;
/**
 * Hard character cap on per-trace context sent to the judge.
 * Set at ~19% of claude-haiku-4-5's 200k-token window (~37k tokens at 4 chars/token),
 * leaving generous headroom for the system prompt + tool definitions + response budget.
 * Smart compression (type-aware truncation + path-based dedup + base64
 * stripping) is a future improvement when we see real customer complaints
 * about traces being truncated. For now, rely on this hard cap.
 */
export const SAFETY_TRUNCATE_CHARS = 150_000;
/** Default screening model for system source — cheap-and-fast, not the agent default. */
const SYSTEM_DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * `tool_choice` value sent to every provider for detector eval.
 *
 * We use `"auto"` universally instead of per-protocol forcing values.
 * Stronger values (`"required"` / `"any"`) trip on real-world quirks:
 *   - OpenAI-compatible providers (Moonshot, DeepSeek-reasoner) reject `"required"`
 *     when thinking is on: `400 tool_choice 'required' is incompatible with thinking enabled`
 *   - `openai-responses` / `azure-openai-responses` only accept `"auto"` per spec
 *
 * Reliability comes from the strict system prompt + retry-once-on-plain-text loop,
 * not from a protocol-level force flag.
 */
const TOOL_CHOICE = "auto";

function errorResult(
  message: string,
  source: "system" | "byok" | null,
  inferenceCost = 0,
  inferenceInputTokens = 0,
  inferenceOutputTokens = 0,
  inferenceModel: string | null = null,
  inferenceProvider: string | null = null,
): EvalResult {
  return {
    identified: false,
    summary: "Analysis failed",
    data: {},
    error: message,
    inferenceCost,
    inferenceInputTokens,
    inferenceOutputTokens,
    inferenceSource: source,
    inferenceModel,
    inferenceProvider,
  };
}

/**
 * Resolve the API key for a detector eval call.
 *   1. BYOK source → the explicit row's decrypted key (in `providerConfig`)
 *   2. System source → env var (pi-ai owns the provider→env-var mapping)
 *   3. System source fallback → any enabled BYOK row in the workspace whose
 *      adapter maps to the same pi-ai provider (matches agent behavior)
 */
async function resolveDetectorApiKey(
  workspaceId: string,
  providerConfig: ProviderModelConfig | null,
  piProvider: string,
): Promise<string | null> {
  if (providerConfig) return providerConfig.key;

  const envKey = getEnvApiKey(piProvider);
  if (envKey) return envKey;

  return findByokKeyForPiProvider(workspaceId, piProvider);
}

/**
 * Run LLM detection for a single trace.
 * spansJsonl is the content of the trace's spans.jsonl file.
 * The LLM must call submit_result; plain-text responses trigger one retry.
 */
export async function runDetectionForTrace(params: {
  traceId: string;
  spansJsonl: string;
  detector: DetectorConfig;
  workspaceId: string;
}): Promise<EvalResult> {
  const { traceId, spansJsonl, detector, workspaceId } = params;
  const source = detector.detectionSource ?? null;

  // 1. BYOK config
  let providerConfig: ProviderModelConfig | null = null;
  if (source === "byok") {
    if (!detector.detectionProvider) {
      return errorResult("BYOK detector has no detectionProvider", source);
    }
    providerConfig = await fetchProviderConfig(workspaceId, detector.detectionProvider);
    if (!providerConfig) {
      return errorResult(
        `BYOK provider "${detector.detectionProvider}" not found or disabled in workspace settings`,
        source,
      );
    }
  }

  // 2. Resolve model
  const modelId =
    detector.detectionModel ?? (source === "system" ? SYSTEM_DEFAULT_MODEL : undefined);
  const model = resolvePiModel(modelId, providerConfig);

  // 3. Resolve API key (BYOK row → env var → workspace BYOK scan)
  const apiKey = await resolveDetectorApiKey(workspaceId, providerConfig, model.provider);
  if (!apiKey) {
    return errorResult(`No API key configured for provider "${model.provider}"`, source);
  }

  // 4. Build prompt + tool
  const submitTool = buildSubmitResultTool(detector.outputSchema);
  const systemPrompt = `You are a production monitoring assistant analyzing AI agent traces.
You are evaluating one trace to determine if it exhibits the problem described below.

RULES:
- Read the spans carefully.
- You MUST call the submit_result tool to complete your analysis. Plain text responses are rejected.
- identified=true means you found the problem. identified=false means the trace is clean.
- summary must be one sentence. If identified=true, describe what you found. If false, state why it is clean.
- data fields are only required when identified=true.`;

  // Disclose incomplete input to the judge so it doesn't infer problems from
  // missing spans: the hard cap truncates the LATEST spans (spans-jsonl is
  // start-time-ordered), so tell the judge not to read meaning into absences.
  const incompleteReasons: string[] = [];
  if (spansJsonl.length > SAFETY_TRUNCATE_CHARS) {
    incompleteReasons.push(`span list truncated at ${SAFETY_TRUNCATE_CHARS} chars`);
  }
  const incompleteNote =
    incompleteReasons.length > 0
      ? `NOTE: The span list below may be INCOMPLETE (${incompleteReasons.join("; ")}). ` +
        `Do not infer missing steps, absent error handling, or wrong conclusions from spans ` +
        `that are absent; only report problems visible in the spans shown.\n`
      : "";

  const userText = `DETECTOR: ${detector.name}

WHAT TO DETECT:
${detector.prompt}

TRACE ID: ${traceId}

SPANS (one JSON object per line):
${incompleteNote}${spansJsonl.slice(0, SAFETY_TRUNCATE_CHARS)}`;

  // 5. Single-shot complete() with retry-once-on-text-response
  const messages: Message[] = [{ role: "user", content: userText, timestamp: Date.now() }];
  let lastError: string | undefined;
  let inferenceCost = 0;
  let inferenceInputTokens = 0;
  let inferenceOutputTokens = 0;
  let inferenceModel: string | null = null;
  let inferenceProvider: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await complete(model, { systemPrompt, messages, tools: [submitTool] }, {
        apiKey,
        toolChoice: TOOL_CHOICE,
      } as Record<string, unknown>);

      inferenceCost += response.usage?.cost?.total ?? 0;
      inferenceInputTokens += response.usage?.input ?? 0;
      inferenceOutputTokens += response.usage?.output ?? 0;
      inferenceModel = response.model ?? inferenceModel;
      inferenceProvider = response.provider ?? inferenceProvider;

      const toolCall = response.content.find(
        (c): c is ToolCall => c.type === "toolCall" && c.name === "submit_result",
      );
      if (toolCall) {
        const args = toolCall.arguments as Partial<SubmitResultInput>;
        return {
          identified: Boolean(args.identified),
          summary: typeof args.summary === "string" ? args.summary : "",
          data: (args.data as Record<string, unknown>) ?? {},
          inferenceCost,
          inferenceInputTokens,
          inferenceOutputTokens,
          inferenceSource: source,
          inferenceModel,
          inferenceProvider,
        };
      }

      // pi-ai swallows API failures into the assistant message with
      // stopReason="error" + an errorMessage field. Treat that as a hard
      // failure — retrying won't help, and we want the upstream error
      // surfaced clearly (e.g. provider rejected toolChoice="required",
      // 401 from a bad key, etc.).
      if (response.stopReason === "error") {
        lastError = response.errorMessage || `provider error (model=${model.id}, api=${model.api})`;
        console.warn(
          `[sandbox-eval] Provider error on attempt ${attempt} (model=${model.id}, api=${model.api}): ${lastError}`,
        );
        break;
      }

      // Plain text — log enough to diagnose provider tool-calling compliance,
      // then append the full assistant turn + a stricter reminder; retry once.
      console.warn(
        `[sandbox-eval] No submit_result on attempt ${attempt} (model=${model.id}, api=${model.api}, stopReason=${response.stopReason}). content=${JSON.stringify(response.content).slice(0, 600)}`,
      );
      messages.push(response);
      messages.push({
        role: "user",
        content: "You must call submit_result. Do not respond with text.",
        timestamp: Date.now(),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  return errorResult(
    lastError ?? "LLM did not call submit_result after retry",
    source,
    inferenceCost,
    inferenceInputTokens,
    inferenceOutputTokens,
    inferenceModel,
    inferenceProvider,
  );
}
