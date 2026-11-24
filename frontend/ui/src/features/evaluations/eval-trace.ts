import type { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";
import type { ResultRow, RunDetail, ScoreRow } from "./types";

/** A score as run detail's results table and the reconstructed trace's scorer spans read
 *  it. */
export function scoreValue(s: ScoreRow): string {
  if (s.error) return "error";
  if (s.numericValue !== null) return String(s.numericValue);
  if (s.boolValue !== null) return s.boolValue ? "true" : "false";
  if (s.stringValue !== null) return s.stringValue;
  if (s.passed !== null) return s.passed ? "pass" : "fail";
  return "—";
}

/** Base span with the fields the trace viewer expects; `partial` overrides. */
function evalSpan(
  partial: Partial<Span> & Pick<Span, "span_id" | "trace_id" | "name" | "span_kind">,
): Span {
  return {
    parent_span_id: null,
    span_start_time: "1970-01-01T00:00:00.000Z",
    span_end_time: "1970-01-01T00:00:00.000Z",
    status: "OK" as SpanStatus,
    status_message: null,
    error_type: partial.status === "ERROR" ? "unknown" : "",
    model_name: null,
    cost: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    input: null,
    output: null,
    metadata: null,
    git_source_file: null,
    git_source_line: null,
    git_source_function: null,
    ...partial,
  };
}

/**
 * The eval-shaped trace for one result, so the run detail opens into the real
 * trace viewer (span tree + span detail) — the shape the SDK reports:
 *
 *   evaluation item (root)
 *     ├─ task span      ← the candidate application's run
 *     ├─ scorer span    ← siblings of the task, one per scorer that ran
 *     └─ scorer span
 *
 * Built from the actual result + scores only (no fabricated sub-spans). This is a
 * clearly-LABELED fallback, used only when a result emitted no real trace; a result
 * with a real ingested trace opens that real trace directly instead.
 */
export function buildEvalTrace(result: ResultRow, run: RunDetail): TraceDetail {
  const id = result.traceId || `eval-${result.id}`;
  const failed = Boolean(result.taskError);
  const rootStatus = (failed ? "ERROR" : "OK") as SpanStatus;

  // Ordered fake timestamps so the reconstructed tree is deterministic and reads in
  // the real order: task first, then scorers (which run after it). Without distinct
  // starts, the stable sibling sort would tie and fall back to span_id.
  const base = new Date(result.createTime).getTime();
  const t0 = Number.isFinite(base) ? base : 0;
  const iso = (ms: number) => new Date(ms).toISOString();

  const spans: Span[] = [
    evalSpan({
      span_id: `${id}-root`,
      trace_id: id,
      name: `${run.evaluationName} · ${result.testCaseId}`,
      span_kind: "AGENT" as SpanKind,
      span_start_time: iso(t0),
      span_end_time: iso(t0 + result.scores.length + 2),
      input: result.input,
      output: result.candidateOutput,
      status: rootStatus,
      status_message: result.taskError ?? null,
      metadata: JSON.stringify({
        evaluation: run.evaluationName,
        candidate_version: run.candidateVersion,
        dataset: run.datasetName,
        test_case: result.testCaseId,
      }),
    }),
    evalSpan({
      span_id: `${id}-task`,
      trace_id: id,
      parent_span_id: `${id}-root`,
      name: "task",
      span_kind: "SPAN" as SpanKind,
      span_start_time: iso(t0),
      span_end_time: iso(t0 + 1),
      input: result.input,
      output: result.candidateOutput,
      cost: result.cost,
      status: rootStatus,
      status_message: result.taskError ?? null,
      metadata: JSON.stringify({ step: "task" }),
    }),
  ];

  // Scorer spans — siblings of the task, one per scorer that ran, starting after it.
  result.scores.forEach((s, i) => {
    spans.push(
      evalSpan({
        span_id: `${id}-scorer-${s.id}`,
        trace_id: id,
        parent_span_id: `${id}-root`,
        name: s.scorerName,
        span_kind: "SPAN" as SpanKind,
        span_start_time: iso(t0 + i + 2),
        span_end_time: iso(t0 + i + 2),
        input: `output: ${result.candidateOutput ?? "—"}\nexpected: ${result.expectedOutput ?? "—"}`,
        output: s.error ?? scoreValue(s),
        status: (s.error ? "ERROR" : "OK") as SpanStatus,
        status_message: s.error ?? null,
        metadata: JSON.stringify({ scorer: s.scorerName, version: s.scorerVersion }),
      }),
    );
  });

  return {
    trace_id: id,
    project_id: run.evaluationId,
    name: `${run.evaluationName} · ${result.testCaseId}`,
    trace_start_time: result.createTime,
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "evaluation",
    release: null,
    input: result.input,
    output: result.candidateOutput,
    metadata: JSON.stringify({ evaluation: run.evaluationName, test_case: result.testCaseId }),
    spans,
  };
}
