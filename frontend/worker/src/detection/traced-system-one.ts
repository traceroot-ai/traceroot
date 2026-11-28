/**
 * Records a decision-model call (TypeSafe System One, the OpenAI Decisions
 * API) as a DECISION span inside an active self-trace scope, mirroring
 * tracedComplete; outside a scope it is a passthrough. The wrapper's own work
 * is guarded so tracing never throws into a detector run.
 */

import {
  SpanStatusCode,
  context as otelContext,
  trace,
  type AttributeValue,
  type Span,
} from "@opentelemetry/api";
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

export interface DecisionTraceMeta {
  /** Span name, e.g. `decisions gpt-6-luna`. */
  name: string;
  /** The API model called; the response's model replaces it when one is sent. */
  model: string;
  /** Recorded (bounded) as the span input. */
  input: unknown;
  /** Set when the span starts, after the common attributes. */
  attributes?: Record<string, AttributeValue>;
}

export interface DecisionTraceFinish {
  /** The model the response names, or null to keep the requested one. */
  model: string | null;
  /** Usage and other result attributes, e.g. gen_ai.usage.input_tokens. */
  attributes: Record<string, AttributeValue>;
  output: unknown;
}

export async function tracedSystemOne<R extends SystemOneResult>(
  meta: SystemOneTraceMeta,
  call: () => Promise<R>,
): Promise<R> {
  return tracedDecision(
    {
      name: `systemone ${meta.model}`,
      model: meta.model,
      input: {
        questions: meta.questions,
        state_preview: meta.statePreview,
        state_stats: meta.stateStats,
      },
      attributes: { "decision.system": "typesafe" },
    },
    call,
    (result) => ({
      model: result.model,
      attributes: {
        "gen_ai.usage.input_tokens": result.usage.inputTokens,
        "gen_ai.usage.output_tokens": result.usage.outputTokens,
      },
      output: result.answers,
    }),
  );
}

export async function tracedDecision<R>(
  meta: DecisionTraceMeta,
  call: () => Promise<R>,
  finish: (result: R) => DecisionTraceFinish,
  /** Usage attributes for a failed call that was still billed, or null. */
  failedUsage?: (err: unknown) => Record<string, number> | null,
): Promise<R> {
  const scope = currentSelfTraceScope();
  if (!scope) return call();

  // Span setup is best-effort: a serialization failure here degrades to an
  // untraced call rather than failing the eval.
  let span: Span | null = null;
  try {
    span = trace.getTracer("traceroot.detector-worker").startSpan(meta.name, {
      attributes: {
        // No source marker: the secret-gated ingest route classifies these rows.
        "traceroot.project_id": scope.projectId,
        "traceroot.span.type": "DECISION",
        // Required by the OpenInference Decision Spans spec; ingest maps both.
        "openinference.span.kind": "DECISION",
        "traceroot.llm.model": meta.model,
        "traceroot.span.input": boundedJson(meta.input),
        ...meta.attributes,
      },
    });
  } catch (err) {
    console.error("[Detector] decision span setup failed:", err);
    span = null;
  }

  try {
    const result = span
      ? await otelContext.with(trace.setSpan(otelContext.active(), span), call)
      : await call();

    try {
      if (span) {
        const done = finish(result);
        if (done.model) span.setAttribute("traceroot.llm.model", done.model);
        span.setAttributes(done.attributes);
        span.setAttribute("traceroot.span.output", boundedJson(done.output));
        span.end();
      }
    } catch (err) {
      console.error("[Detector] decision span finish failed:", err);
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
      const billed = span && failedUsage ? failedUsage(err) : null;
      if (billed) span?.setAttributes(billed);
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
