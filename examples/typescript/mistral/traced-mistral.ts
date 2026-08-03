/**
 * traced-mistral.ts — manual OpenInference-compatible tracing for @mistralai/mistralai
 *
 * Why this file exists
 * --------------------
 * @traceroot-ai/traceroot does not yet ship auto-instrumentation for the
 * Mistral SDK (tracked in https://github.com/traceroot-ai/traceroot/issues/739).
 * Until a dedicated MistralInstrumentation lands in the SDK, this module wraps
 * `mistral.chat.complete` with `observe()` and emits the same OpenInference
 * span attributes a future auto-instrumentor would emit:
 *
 *   openinference.span.kind   = "LLM"
 *   llm.system                = "mistralai"
 *   llm.provider              = "mistralai"
 *   llm.model_name            = <model>
 *   llm.token_count.prompt    = usage.promptTokens
 *   llm.token_count.completion= usage.completionTokens
 *   llm.token_count.total     = usage.totalTokens
 *   llm.invocation_parameters = JSON of non-message params (model, tools, ...)
 *   input.value               = JSON of messages
 *   input.mime_type           = "application/json"
 *   output.value              = JSON of completion message
 *   output.mime_type          = "application/json"
 *
 * That means traces look correct *today*, and once the SDK ships
 * `instrumentModules: { mistral }` the only diff in user code is:
 *   - delete this file
 *   - replace `tracedComplete(mistral, args)` with `mistral.chat.complete(args)`
 *
 * This module is also a useful starting point for the SDK-side
 * MistralInstrumentation: the attribute mapping, finish-reason mapping, and
 * tool-call serialisation are the same shape an InstrumentationBase
 * monkey-patch would emit per OpenInference's chat-completion semantic
 * conventions.
 */

import type { Mistral } from '@mistralai/mistralai';
import { observe, updateCurrentSpan } from '@traceroot-ai/traceroot';

type ChatCompleteArgs = Parameters<Mistral['chat']['complete']>[0];
type ChatCompleteResult = Awaited<ReturnType<Mistral['chat']['complete']>>;

const PROVIDER = 'mistralai';

// Mirror of the OpenInference attribute names — kept as constants so the
// future SDK instrumentor can import the exact same keys without drift.
const ATTR = {
  spanKind: 'openinference.span.kind',
  system: 'llm.system',
  provider: 'llm.provider',
  modelName: 'llm.model_name',
  tokenPrompt: 'llm.token_count.prompt',
  tokenCompletion: 'llm.token_count.completion',
  tokenTotal: 'llm.token_count.total',
  invocationParams: 'llm.invocation_parameters',
  inputValue: 'input.value',
  inputMime: 'input.mime_type',
  outputValue: 'output.value',
  outputMime: 'output.mime_type',
  finishReason: 'llm.response.finish_reasons',
  toolName: 'llm.tools',
} as const;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Drop-in replacement for `mistral.chat.complete(args)` that opens an LLM span,
 * captures inputs / outputs / tokens, and re-throws any error after recording it.
 */
export async function tracedComplete(
  mistral: Mistral,
  args: ChatCompleteArgs,
): Promise<ChatCompleteResult> {
  const model = args.model;
  const spanName = `mistral.chat.complete ${model}`;

  return observe(
    {
      name: spanName,
      type: 'llm',
      metadata: {
        [ATTR.spanKind]: 'LLM',
        [ATTR.system]: PROVIDER,
        [ATTR.provider]: PROVIDER,
        [ATTR.modelName]: model,
      },
    },
    async () => {
      const { messages, ...invocationParams } = args;

      updateCurrentSpan({
        input: { messages },
        metadata: {
          [ATTR.inputValue]: safeStringify(messages),
          [ATTR.inputMime]: 'application/json',
          [ATTR.invocationParams]: safeStringify(invocationParams),
        },
      });

      const response = await mistral.chat.complete(args);

      const choice = response.choices?.[0];
      const message = choice?.message;
      const finishReason = choice?.finishReason;
      const usage = response.usage;

      updateCurrentSpan({
        output: { message },
        metadata: {
          [ATTR.outputValue]: safeStringify(message),
          [ATTR.outputMime]: 'application/json',
          [ATTR.tokenPrompt]: usage?.promptTokens ?? 0,
          [ATTR.tokenCompletion]: usage?.completionTokens ?? 0,
          [ATTR.tokenTotal]: usage?.totalTokens ?? 0,
          [ATTR.finishReason]: finishReason ? [finishReason] : [],
        },
      });

      return response;
    },
  );
}
