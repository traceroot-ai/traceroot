/**
 * Tracing wrapper around pi-ai's complete(): inside an active self-trace
 * scope it records the call as a real LLM span — actual (truncated)
 * transcript in, actual response content out, true model/token usage —
 * parented to whatever span is active (the detector-run root). Outside a
 * scope it is a pure passthrough, so unit tests and any non-traced caller
 * see pi-ai behavior byte-identical.
 *
 * The LLM span is captured at the client boundary, so every attempt
 * (including the retry-on-plain-text loop) gets its own span, and any future
 * pi-ai caller inside a traced scope (the RCA agent) is covered by the same
 * wrapper. All of the wrapper's OWN work (span ops, serialization) is
 * guarded: only errors originating from complete() itself propagate to the
 * caller — tracing must never throw into a detector run.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import { SpanStatusCode, context as otelContext, trace, type Span } from "@opentelemetry/api";
import { currentSelfTraceScope } from "./self-trace-emitter.js";

/** Per-side cap on recorded transcript text. The judge input embeds up to
 * ~150KB of customer span dump; the self-trace keeps a bounded head (system
 * prompt + detector prompt + the start of the spans context), never the
 * whole payload — the full data lives in the scanned trace itself. */
export const LLM_IO_CAP = 8_000;

interface CompletionContextLike {
  systemPrompt?: string;
  messages?: unknown;
}

function truncate(text: string): string {
  if (text.length <= LLM_IO_CAP) return text;
  // Don't split a surrogate pair at the cap: a dangling high surrogate would
  // corrupt the recorded text's last character, so drop it instead.
  let end = LLM_IO_CAP;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Serialize a bounded transcript that is ALWAYS valid JSON: long strings are
 * truncated INSIDE the structure (per message content / per block), never by
 * slicing the serialized JSON — the trace view pretty-renders JSON inputs and
 * falls back to raw text if parsing fails.
 */
export function boundedJson(value: unknown): string {
  const bound = (v: unknown): unknown => {
    if (typeof v === "string") return truncate(v);
    if (Array.isArray(v)) return v.map(bound);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, bound(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(bound(value));
}

export async function tracedComplete(
  ...args: Parameters<typeof complete>
): Promise<Awaited<ReturnType<typeof complete>>> {
  const scope = currentSelfTraceScope();
  if (!scope) return complete(...args);

  // Span setup is best-effort: a serialization failure here degrades to an
  // untraced call rather than failing the eval.
  let span: Span | null = null;
  try {
    const [model, completionContext] = args as [
      { id?: string } | string,
      CompletionContextLike,
      ...unknown[],
    ];
    const requestedModel = typeof model === "string" ? model : (model?.id ?? "unknown-model");
    // "traceroot." prefix: the backend's token normalizer recognizes the scope
    // family, so this emitter never trips the unknown-emitter warning.
    span = trace.getTracer("traceroot.detector-worker").startSpan(`chat ${requestedModel}`, {
      attributes: {
        "traceroot.source": "detector",
        "traceroot.project_id": scope.projectId,
        "traceroot.span.type": "LLM",
        "traceroot.llm.model": requestedModel,
        "traceroot.span.input": boundedJson({
          systemPrompt: completionContext?.systemPrompt,
          messages: completionContext?.messages,
        }),
      },
    });
  } catch (err) {
    console.error("[Detector] llm span setup failed:", err);
    span = null;
  }

  try {
    const response = span
      ? await otelContext.with(trace.setSpan(otelContext.active(), span), () => complete(...args))
      : await complete(...args);

    try {
      if (span) {
        if (response.model) span.setAttribute("traceroot.llm.model", response.model);
        const usage = response.usage;
        if (typeof usage?.input === "number") {
          // pi-ai's `input` is the UNCACHED input only (Anthropic reports
          // input_tokens exclusive of cache). The cache buckets ride along as
          // their own attributes; the transform floors the tiny uncached
          // remainder to zero and stores gross input as the bucket sum.
          span.setAttribute("gen_ai.usage.input_tokens", usage.input);
        }
        if (typeof usage?.output === "number") {
          span.setAttribute("gen_ai.usage.output_tokens", usage.output);
        }
        if (usage?.cacheRead) {
          span.setAttribute("gen_ai.usage.cache_read.input_tokens", usage.cacheRead);
        }
        if (usage?.cacheWrite) {
          span.setAttribute("gen_ai.usage.cache_creation.input_tokens", usage.cacheWrite);
        }
        if (usage?.cacheWrite1h) {
          span.setAttribute(
            "gen_ai.usage.cache_creation.ephemeral_1h_input_tokens",
            usage.cacheWrite1h,
          );
        }
        if (usage?.reasoning) {
          span.setAttribute("gen_ai.usage.reasoning_tokens", usage.reasoning);
        }
        span.setAttribute("traceroot.span.output", boundedJson(response.content));
        // "aborted" is sandbox-eval's terminal timeout path — an unhealthy
        // attempt, so the span must not read as OK.
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message:
              response.stopReason === "aborted"
                ? "aborted (timeout)"
                : response.errorMessage || "provider error",
          });
        }
        span.end();
      }
    } catch (err) {
      console.error("[Detector] llm span finish failed:", err);
      try {
        span?.end();
      } catch {
        /* best-effort */
      }
    }
    return response;
  } catch (err) {
    // Only complete()'s own failure reaches here — record and rethrow.
    try {
      span?.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span?.end();
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
