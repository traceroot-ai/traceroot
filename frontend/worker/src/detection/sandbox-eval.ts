import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { resolveWorkspaceApiKey } from "@traceroot/core";
import { buildSubmitResultTool, type SubmitResultInput } from "./submit-result-tool.js";

export interface DetectorConfig {
  id: string;
  name: string;
  prompt: string;
  outputSchema: Array<{ name: string; type: string }>;
  detectionModel?: string | null;
  detectionProvider?: string | null;
  detectionAdapter?: string | null;
}

export interface EvalResult {
  identified: boolean;
  summary: string;
  data: Record<string, unknown>;
  error?: string;
}

const DEFAULT_DETECTION_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_DETECTION_PROVIDER = "anthropic";

async function runDetectionWithAnthropic(params: {
  traceId: string;
  userMessage: string;
  systemPrompt: string;
  model: string;
  apiKey: string;
  submitTool: ReturnType<typeof buildSubmitResultTool>;
}): Promise<EvalResult> {
  const client = new Anthropic({ apiKey: params.apiKey });

  let identified = false;
  let summary = "Analysis failed";
  let data: Record<string, unknown> = {};
  let error: string | undefined;

  try {
    let continueLoop = true;
    let messages: Anthropic.MessageParam[] = [{ role: "user", content: params.userMessage }];
    let attempts = 0;

    while (continueLoop && attempts < 5) {
      attempts++;
      const response = await client.messages.create({
        model: params.model,
        max_tokens: 1024,
        system: params.systemPrompt,
        tools: [params.submitTool as Anthropic.Tool],
        tool_choice: { type: "any" }, // force tool use
        messages,
      });

      // Look for submit_result tool call
      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === "tool_use" && block.name === "submit_result",
      );

      if (toolUse) {
        const input = toolUse.input as SubmitResultInput;
        identified = input.identified;
        summary = input.summary;
        data = input.data || {};
        continueLoop = false;
      } else if (response.stop_reason === "end_turn") {
        // LLM gave plain text — retry with reminder
        messages = [
          ...messages,
          { role: "assistant", content: response.content },
          { role: "user", content: "You must call submit_result. Do not respond with text." },
        ];
      } else {
        continueLoop = false;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return { identified, summary, data, error };
}

async function runDetectionWithOpenAI(params: {
  traceId: string;
  userMessage: string;
  systemPrompt: string;
  model: string;
  apiKey: string;
  submitTool: ReturnType<typeof buildSubmitResultTool>;
}): Promise<EvalResult> {
  const client = new OpenAI({ apiKey: params.apiKey });

  // Convert Anthropic tool schema to OpenAI format
  const tool: OpenAI.Chat.ChatCompletionTool = {
    type: "function",
    function: {
      name: "submit_result",
      description: params.submitTool.description,
      parameters: params.submitTool.input_schema as Record<string, unknown>,
    },
  };

  let identified = false;
  let summary = "Analysis failed";
  let data: Record<string, unknown> = {};
  let error: string | undefined;

  try {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userMessage },
    ];

    let continueLoop = true;
    let attempts = 0;

    while (continueLoop && attempts < 5) {
      attempts++;
      const response = await client.chat.completions.create({
        model: params.model,
        max_tokens: 1024,
        messages,
        tools: [tool],
        tool_choice: "required",
      });

      const choice = response.choices[0];
      const toolCall = choice.message.tool_calls?.find(
        (tc) => tc.function.name === "submit_result",
      );

      if (toolCall) {
        const input = JSON.parse(toolCall.function.arguments) as {
          identified: boolean;
          summary: string;
          data?: Record<string, unknown>;
        };
        identified = input.identified;
        summary = input.summary;
        data = input.data ?? {};
        continueLoop = false;
      } else if (choice.finish_reason === "stop") {
        messages.push({ role: "assistant", content: choice.message.content ?? "" });
        messages.push({
          role: "user",
          content: "You must call submit_result. Do not respond with text.",
        });
      } else {
        continueLoop = false;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return { identified, summary, data, error };
}

/**
 * Run LLM detection for a single trace.
 * spansJsonl is the content of the trace's spans.jsonl file.
 * The LLM must call submit_result to complete — plain text responses are retried.
 */
export async function runDetectionForTrace(params: {
  traceId: string;
  spansJsonl: string;
  detector: DetectorConfig;
  workspaceId: string;
}): Promise<EvalResult> {
  const { traceId, spansJsonl, detector, workspaceId } = params;

  const model = detector.detectionModel || DEFAULT_DETECTION_MODEL;
  const provider = detector.detectionProvider || DEFAULT_DETECTION_PROVIDER;
  const adapter = detector.detectionAdapter || "anthropic";

  // Resolve the API key for the chosen provider, falling back to env var
  const envVarFallback = adapter === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const apiKey = await resolveWorkspaceApiKey(workspaceId, provider, envVarFallback);
  const submitTool = buildSubmitResultTool(detector.outputSchema);

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
${spansJsonl.slice(0, 40000)}`; // safety truncation at ~10k tokens

  if (adapter === "openai") {
    return runDetectionWithOpenAI({
      traceId,
      userMessage,
      systemPrompt,
      model,
      apiKey,
      submitTool,
    });
  }

  return runDetectionWithAnthropic({
    traceId,
    userMessage,
    systemPrompt,
    model,
    apiKey,
    submitTool,
  });
}
