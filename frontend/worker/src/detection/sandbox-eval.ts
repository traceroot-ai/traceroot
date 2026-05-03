/**
 * Detector sandbox LLM evaluation — routes through pi-ai (`complete`) using the same
 * model resolution as the agent ({@link resolvePiModel} on `@traceroot/core/pi-model`),
 * keyed by API protocol (not per-vendor SDK forks). {@link runDetectionForTrace} enforces
 * structured output via the `submit_result` tool.
 */
import {
  complete,
  getEnvApiKey,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
} from "@mariozechner/pi-ai";
import {
  prisma,
  decryptKey,
  ADAPTER_TO_PI_AI,
  ADAPTER_MODELS,
  BEDROCK_USE_DEFAULT_CREDENTIALS,
  ModelSource,
  type LLMAdapter,
} from "@traceroot/core";
import { resolvePiModel, type ProviderModelConfig } from "@traceroot/core/pi-model";
import { buildSubmitResultToolForPiAi, type SubmitResultInput } from "./submit-result-tool";

export interface DetectorConfig {
  id: string;
  name: string;
  prompt: string;
  outputSchema: Array<{ name: string; type: string }>;
  detectionModel?: string | null;
  /** Workspace model provider row label, or legacy `"openai"` / `"anthropic"` for env/BYOK lookup. */
  detectionProvider?: string | null;
  detectionAdapter?: string | null;
  /** When `byok`, {@link detectionProvider} must match `ModelProvider.provider` in the workspace. */
  detectionModelSource?: import("@traceroot/core").ModelSource;
}

export interface EvalResult {
  identified: boolean;
  summary: string;
  data: Record<string, unknown>;
  error?: string;
}

export interface DetectorSandboxEvalInput {
  workspaceId: string;
  model?: string;
  providerName?: string;
  source?: import("@traceroot/core").ModelSource;
  systemPrompt: string;
  messages: Message[];
  signal?: AbortSignal;
  maxTokens?: number;
}

const DEFAULT_ADAPTER = "anthropic";

/** Defaults when `detectionModel` is unset — prefer small / fast models (not first catalog SKU). */
const DETECTION_DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
  google: "gemini-2.5-flash",
  deepseek: "deepseek-chat",
  openrouter: "openai/gpt-4o-mini",
  xai: "grok-4",
  moonshot: "kimi-k2.5",
  zai: "glm-5-turbo",
  azure: "gpt-5-mini",
};

async function fetchProviderModelConfig(
  workspaceId: string,
  providerName: string,
): Promise<ProviderModelConfig | null> {
  try {
    const row = await prisma.modelProvider.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: providerName } },
      select: {
        adapter: true,
        keyCipher: true,
        enabled: true,
        baseUrl: true,
        config: true,
      },
    });

    if (row?.enabled && row.keyCipher) {
      return {
        adapter: row.adapter,
        key: decryptKey(row.keyCipher),
        baseUrl: row.baseUrl,
        config: row.config as Record<string, unknown> | null,
      };
    }
  } catch (err) {
    console.error(`[DetectorEval] Failed to load BYOK provider "${providerName}":`, err);
  }
  return null;
}

async function fetchAnyByokKeyForPiProvider(
  workspaceId: string,
  piProvider: string,
): Promise<string | null> {
  try {
    const rows = await prisma.modelProvider.findMany({
      where: { workspaceId, enabled: true },
      select: { adapter: true, keyCipher: true },
    });
    for (const row of rows) {
      if (!row.keyCipher) continue;
      const mapped = ADAPTER_TO_PI_AI[row.adapter];
      if (mapped === piProvider) {
        return decryptKey(row.keyCipher);
      }
    }
  } catch (err) {
    console.warn(`[DetectorEval] Failed to list BYOK keys for workspace ${workspaceId}:`, err);
  }
  return null;
}

async function resolveEvalApiKey(
  workspaceId: string,
  source: import("@traceroot/core").ModelSource | undefined,
  providerConfig: ProviderModelConfig | null,
  piProvider: string,
): Promise<string> {
  if (providerConfig && providerConfig.key !== BEDROCK_USE_DEFAULT_CREDENTIALS) {
    const mapped = ADAPTER_TO_PI_AI[providerConfig.adapter];
    if (mapped === piProvider) {
      return providerConfig.key;
    }
  }
  if (source !== ModelSource.BYOK) {
    const envKey = getEnvApiKey(piProvider);
    if (envKey) return envKey;
  }
  const fromWorkspace = await fetchAnyByokKeyForPiProvider(workspaceId, piProvider);
  if (fromWorkspace) return fromWorkspace;
  return getEnvApiKey(piProvider) || "";
}

function toolChoiceForModel(model: Model<Api>): string {
  if (model.api === "anthropic-messages") return "any";
  return "required";
}

function defaultDetectionModelId(adapter: string): string {
  const preferred = DETECTION_DEFAULT_MODEL[adapter];
  if (preferred) return preferred;
  const catalog = ADAPTER_MODELS[adapter as LLMAdapter];
  if (catalog?.[0]?.id) return catalog[0].id;
  return "claude-haiku-4-5";
}

/**
 * Non-streaming completion for simple detector prompts (no forced tool schema).
 */
export async function completeDetectorSandboxEval(
  input: DetectorSandboxEvalInput,
): Promise<AssistantMessage> {
  let providerConfig: ProviderModelConfig | null = null;
  if (input.source === ModelSource.BYOK && input.providerName) {
    providerConfig = await fetchProviderModelConfig(input.workspaceId, input.providerName);
    if (!providerConfig) {
      throw new Error(
        `BYOK provider "${input.providerName}" not found or disabled for workspace ${input.workspaceId}.`,
      );
    }
  }

  const model = resolvePiModel(input.model, providerConfig);
  const apiKey = await resolveEvalApiKey(
    input.workspaceId,
    input.source,
    providerConfig,
    model.provider as string,
  );

  return complete(
    model,
    { systemPrompt: input.systemPrompt, messages: input.messages },
    {
      apiKey: apiKey || undefined,
      signal: input.signal,
      maxTokens: input.maxTokens,
    },
  );
}

/**
 * Run LLM detection for a single trace.
 * `spansJsonl` is the content of the trace's spans.jsonl file.
 * The model must call `submit_result` to complete — plain text responses are retried.
 */
export async function runDetectionForTrace(params: {
  traceId: string;
  spansJsonl: string;
  detector: DetectorConfig;
  workspaceId: string;
}): Promise<EvalResult> {
  const { traceId, spansJsonl, detector, workspaceId } = params;

  const source = detector.detectionModelSource ?? ModelSource.SYSTEM;
  let providerConfig: ProviderModelConfig | null = null;

  if (source === ModelSource.BYOK) {
    if (!detector.detectionProvider) {
      return {
        identified: false,
        summary: "Analysis failed",
        data: {},
        error:
          "BYOK detector requires detectionProvider (workspace model provider name from settings).",
      };
    }
    providerConfig = await fetchProviderModelConfig(workspaceId, detector.detectionProvider);
    if (!providerConfig) {
      return {
        identified: false,
        summary: "Analysis failed",
        data: {},
        error: `BYOK provider "${detector.detectionProvider}" not found or disabled.`,
      };
    }
  }

  const adapter = providerConfig?.adapter ?? detector.detectionAdapter ?? DEFAULT_ADAPTER;
  const modelId = detector.detectionModel?.trim() || defaultDetectionModelId(adapter);

  const model = resolvePiModel(modelId, providerConfig);
  const apiKey = await resolveEvalApiKey(
    workspaceId,
    source,
    providerConfig,
    model.provider as string,
  );

  if (!apiKey) {
    return {
      identified: false,
      summary: "Analysis failed",
      data: {},
      error: "No API key configured for this model provider.",
    };
  }

  const tool = buildSubmitResultToolForPiAi(detector.outputSchema);
  const systemPrompt = `You are a production monitoring assistant analyzing AI agent traces.
You are evaluating one trace to determine if it exhibits the problem described below.

RULES:
- Read the spans carefully.
- You MUST call the submit_result tool to complete your analysis. Plain text responses are rejected.
- identified=true means you found the problem. identified=false means the trace is clean.
- summary must be one sentence. If identified=true, describe what you found. If false, state why it is clean.
- data fields are only required when identified=true.`;

  const userMessage = `DETECTOR: ${detector.name}

WHAT TO DETECT:
${detector.prompt}

TRACE ID: ${traceId}

SPANS (one JSON object per line):
${spansJsonl.slice(0, 40000)}`;

  const messages: Message[] = [{ role: "user", content: userMessage, timestamp: Date.now() }];

  const toolChoice = toolChoiceForModel(model);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const assistant = await complete(
        model,
        { systemPrompt, messages, tools: [tool] },
        {
          apiKey,
          maxTokens: 1024,
          toolChoice,
        },
      );

      const toolCall = assistant.content.find(
        (c): c is ToolCall => c.type === "toolCall" && c.name === "submit_result",
      );
      if (toolCall) {
        const input = toolCall.arguments as SubmitResultInput;
        return {
          identified: input.identified,
          summary: input.summary,
          data: input.data ?? {},
        };
      }

      messages.push(assistant);
      messages.push({
        role: "user",
        content: "You must call submit_result. Do not respond with text.",
        timestamp: Date.now(),
      });
    } catch (e) {
      return {
        identified: false,
        summary: "Analysis failed",
        data: {},
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return {
    identified: false,
    summary: "Analysis failed",
    data: {},
    error: "Model did not call submit_result after retries",
  };
}
