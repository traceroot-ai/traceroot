/**
 * Records a TypeSafe System One call as an LLM span inside an active self-trace
 * scope, mirroring tracedComplete; outside a scope it is a passthrough. The
 * wrapper's own work is guarded so tracing never throws into a detector run.
 */

import { SpanStatusCode, context as otelContext, trace, type Span } from "@opentelemetry/api";
import { currentSelfTraceScope } from "./self-trace-emitter.js";
import { boundedJson } from "./traced-complete.js";
import type { SystemOneQuestion, SystemOneResult } from "./typesafe-client.js";

export interface SystemOneTraceMeta {
  model: string;
  questions: Record<string, SystemOneQuestion>;
  /** Serialized state; boundedJson caps it at LLM_IO_CAP (8k) on record. */
  statePreview: string;
  /** Reduction stats from the state projection (e.g. omitted_spans). */
  stateStats: Record<string, number>;
}

export async function tracedSystemOne<R extends SystemOneResult>(
  meta: SystemOneTraceMeta,
  call: () => Promise<R>,
): Promise<R> {
  const scope = currentSelfTraceScope();
  if (!scope) return call();

  // Span setup is best-effort: a serialization failure here degrades to an
  // untraced call rather than failing the eval.
  let span: Span | null = null;
  try {
    span = trace.getTracer("traceroot.detector-worker").startSpan(`systemone ${meta.model}`, {
      attributes: {
        // No source marker: the secret-gated ingest route classifies these rows.
        "traceroot.project_id": scope.projectId,
        "traceroot.span.type": "LLM",
        "traceroot.llm.model": meta.model,
        "traceroot.span.input": boundedJson({
          questions: meta.questions,
          state_preview: meta.statePreview,
          state_stats: meta.stateStats,
        }),
      },
    });
  } catch (err) {
    console.error("[Detector] system-one span setup failed:", err);
    span = null;
  }

  try {
    const result = span
      ? await otelContext.with(trace.setSpan(otelContext.active(), span), call)
      : await call();

    try {
      if (span) {
        if (result.model) span.setAttribute("traceroot.llm.model", result.model);
        span.setAttribute("gen_ai.usage.input_tokens", result.usage.inputTokens);
        span.setAttribute("gen_ai.usage.output_tokens", result.usage.outputTokens);
        span.setAttribute("traceroot.span.output", boundedJson(result.answers));
        span.end();
      }
    } catch (err) {
      console.error("[Detector] system-one span finish failed:", err);
      try {
        span?.end();
      } catch {
        /* best-effort */
      }
    }
    return result;
  } catch (err) {
    // Only the call's own failure reaches here — record and rethrow.
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
