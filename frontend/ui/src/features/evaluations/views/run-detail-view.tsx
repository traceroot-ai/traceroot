"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useSeedTraceIO } from "@/features/offline-eval/components";
import { TraceViewerPanel } from "@/features/traces/components";
import { useTrace } from "@/features/traces/hooks";
import type { Span, TraceDetail } from "@/types/api";
import type { SpanKind, SpanStatus } from "@traceroot/core";
import { cn } from "@/lib/utils";
import { useEvaluationRun } from "../hooks";
import { SaveTestCaseDrawer } from "../components/trace-integration";
import type { ResultRow, RunDetail, ScoreRow } from "../types";

/** Case/run duration; "Unknown" when unmeasured (never 0s). */
function fmtDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "Unknown";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function scoreValue(s: ScoreRow): string {
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
function buildEvalTrace(result: ResultRow, run: RunDetail): TraceDetail {
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

/**
 * Evaluation run detail — a plain, trace-list-style surface: the experiment name
 * rides in the breadcrumb, then a searchable table of the run's per-case results
 * (one column per scorer). Run identity, run switching, and cross-run comparison
 * all live on the Experiments list now (row selection → Actions → Compare), so
 * this page carries no header of its own.
 *
 * Opening a result opens the REAL trace viewer (span tree + span detail) on that
 * result's trace — or, when a result emitted no telemetry, a clearly-labeled
 * reconstructed eval-shaped trace built from the result + its scores.
 */
export function RunDetailView({ projectId, runId }: { projectId: string; runId: string }) {
  const { data, isLoading, error } = useEvaluationRun(projectId, runId);
  const [openResultId, setOpenResultId] = React.useState<string | null>(null);
  // "Save as test case" drawer (only for real ingested traces): which span it targets.
  const [saveTestCaseOpen, setSaveTestCaseOpen] = React.useState(false);
  const [saveTestCaseSpanId, setSaveTestCaseSpanId] = React.useState<string | undefined>(undefined);

  const results = React.useMemo(() => data?.results ?? [], [data]);
  const run = data?.run;

  const openResult = openResultId ? (results.find((r) => r.id === openResultId) ?? null) : null;

  // Prefer the result's REAL ingested trace. Probe it — this shares TraceViewerPanel's
  // ["trace", projectId, traceId] cache key, so opening the real panel does not refetch.
  // A result trace id means telemetry was emitted: show the real trace when it's
  // available, and a pending state (retry) while it is still ingesting. When no trace
  // id was emitted (fully-local run), fall back to a clearly-labeled reconstructed trace.
  const realTraceId = openResult?.traceId ?? null;
  const realTrace = useTrace(projectId, realTraceId ?? "", !!realTraceId);
  // Only treat a reported trace as "pending" when its fetch genuinely fails (not yet
  // ingested → 404). While it's merely loading, keep the trace panel mounted and let it
  // show its own loading — so navigating between results updates in place instead of
  // flickering through the pending panel and re-animating the slide-in.
  const tracePending = !!realTraceId && realTrace.isError;
  const useRealTrace = !!realTraceId && !realTrace.isError;

  // Reconstructed eval-shaped trace — the labeled fallback, only for results that
  // emitted no real trace. Seed span I/O just for those so the detail panel has it.
  const fallbackTrace = React.useMemo(
    () => (run && openResult && !realTraceId ? buildEvalTrace(openResult, run) : undefined),
    [run, openResult, realTraceId],
  );
  const fallbackTraces = React.useMemo(
    () => (run ? results.filter((r) => !r.traceId).map((r) => buildEvalTrace(r, run)) : []),
    [results, run],
  );
  useSeedTraceIO(projectId, fallbackTraces);

  const panelTraceId = useRealTrace ? realTraceId : fallbackTrace?.trace_id;
  const panelOverride = useRealTrace ? undefined : fallbackTrace;

  const closeResult = () => setOpenResultId(null);

  // The trace panel's up/down chevrons step between this run's results, so you can
  // walk case-by-case without closing it.
  const openIndex = openResult ? results.findIndex((r) => r.id === openResult.id) : -1;
  const navigateResult = (dir: "up" | "down") => {
    if (openIndex === -1) return;
    const next = dir === "up" ? openIndex - 1 : openIndex + 1;
    if (next >= 0 && next < results.length) setOpenResultId(results[next].id);
  };

  return (
    <>
      {/* The experiment name rides in the top breadcrumb bar (Workspace / Project /
          Experiments / <name>), like the dataset detail page. */}
      <ProjectBreadcrumb
        projectId={projectId}
        trail={[{ label: "Experiments", href: `/projects/${projectId}/evaluations` }]}
        current={data?.run.evaluationName}
      />
      <div className="flex flex-1 flex-col overflow-hidden text-[12px]">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <p className="text-[13px] text-muted-foreground">Loading run...</p>
          </div>
        ) : error || !data ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2">
            <p className="text-[13px] text-destructive">Evaluation run not found</p>
            <Link
              href={`/projects/${projectId}/evaluations`}
              className="text-[12px] text-muted-foreground underline"
            >
              Back to evaluations
            </Link>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <ResultsSection
              results={results}
              onOpen={setOpenResultId}
              openResultId={openResultId}
            />
          </div>
        )}
      </div>

      {/* Telemetry for this result is still ingesting — pending state with retry. */}
      {openResult && run && tracePending && (
        <PendingTracePanel
          traceId={realTraceId as string}
          isFetching={realTrace.isFetching}
          onRetry={() => realTrace.refetch()}
          onClose={closeResult}
        />
      )}

      {/* The result opens directly in the REAL trace viewer (span tree + span detail)
          when its trace is available; otherwise a clearly-labeled reconstructed trace.
          The evaluation context, scores, and human review are the span-actions panel. */}
      {openResult && run && !tracePending && panelTraceId && (
        <TraceViewerPanel
          // No key on panelTraceId: navigating results updates the panel in place
          // (TraceViewerPanel resets its selection on traceId change), matching the
          // trace-list navigation — a fresh key would replay the slide-in animation.
          projectId={projectId}
          traceId={panelTraceId}
          traceOverride={panelOverride}
          hideDetectors
          newTabPath={`/projects/${projectId}/evaluations/${runId}`}
          onClose={closeResult}
          onNavigate={navigateResult}
          canNavigateUp={openIndex > 0}
          canNavigateDown={openIndex >= 0 && openIndex < results.length - 1}
          // No headerIdentity override: the header reads "Trace <trace-id>" exactly
          // like a normal trace detail (the eval-specific "Test case" label + the
          // odd test-case id are gone).
          // While the "Save as test case" drawer is open, clicking a different span
          // retargets it to that span.
          onSelectionChange={(selection) => {
            if (saveTestCaseOpen) {
              setSaveTestCaseSpanId(selection.type === "span" ? selection.span.span_id : undefined);
            }
          }}
          // The same "+ Add to datasets" affordance as a normal trace detail: save the
          // selected span (or the trace root) of this result's trace as a test case.
          // Only for a REAL ingested trace — a reconstructed result has no telemetry
          // trace id, and SaveTestCaseDrawer refuses to render without one, so the
          // button would be a no-op. Omit it there rather than show a dead control.
          spanHeaderAction={
            useRealTrace
              ? (selection) => (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 gap-1.5 text-[12px]"
                    onClick={() => {
                      setSaveTestCaseSpanId(
                        selection.type === "span" ? selection.span.span_id : undefined,
                      );
                      setSaveTestCaseOpen(true);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add to datasets
                  </Button>
                )
              : undefined
          }
          spanExtraTags={() => (
            <>
              {!useRealTrace && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-100/60 px-2.5 py-1 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
                  Reconstructed — no telemetry was emitted for this result
                </span>
              )}
            </>
          )}
        />
      )}

      {/* Save a span (or the trace root) of the open result's real trace as a test case. */}
      <SaveTestCaseDrawer
        projectId={projectId}
        traceId={useRealTrace ? realTraceId : null}
        spanId={saveTestCaseSpanId}
        open={saveTestCaseOpen}
        onOpenChange={setSaveTestCaseOpen}
      />
    </>
  );
}

/** Slide-in panel shown while a result's real trace is still ingesting. */
function PendingTracePanel({
  traceId,
  isFetching,
  onRetry,
  onClose,
}: {
  traceId: string;
  isFetching: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[45%] min-w-[520px] max-w-[94vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <span className="text-sm font-medium">Evaluation trace</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[12px]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-[13px] font-medium">Trace is still being ingested</p>
        <p className="max-w-[360px] leading-relaxed text-muted-foreground">
          This result reported a trace (<span className="font-mono">{traceId.slice(0, 12)}…</span>),
          but its telemetry hasn&apos;t finished ingesting yet. It will appear here once it lands.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-[12px]"
          disabled={isFetching}
          onClick={onRetry}
        >
          <Loader2 className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden />
          Retry
        </Button>
      </div>
    </div>
  );
}

function ResultsSection({
  results,
  onOpen,
  openResultId,
}: {
  results: ResultRow[];
  onOpen: (id: string) => void;
  openResultId: string | null;
}) {
  const [keyword, setKeyword] = React.useState("");

  const visible = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return results;
    return results.filter(
      (r) =>
        r.input.toLowerCase().includes(q) ||
        (r.candidateOutput ?? "").toLowerCase().includes(q) ||
        (r.expectedOutput ?? "").toLowerCase().includes(q),
    );
  }, [results, keyword]);

  // One column per scorer that appears in the results (union, stable order). A run
  // can carry many scorers, so the table below scrolls horizontally rather than
  // squeezing them. Each cell shows that scorer's value for the case, or "—".
  const scorerNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const r of results) for (const s of r.scores) names.add(s.scorerName);
    return [...names].sort();
  }, [results]);
  const scoreFor = (result: ResultRow, name: string) =>
    result.scores.find((s) => s.scorerName === name) ?? null;
  // Input, Output, Expected, Duration, Cost + one per scorer.
  const columnCount = 5 + scorerNames.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Just a search over the run's per-case results — no headline metrics,
          status filters, pass-rate summary, or worst-regression sort. A run has
          many scores; the per-case rows speak for themselves, like a trace's spans. */}
      <SearchFilterBar
        searchInput={
          <div className="relative min-w-[10rem] max-w-md flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Search..."
              className="h-7 pl-8 text-[12px]"
            />
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <Th className="min-w-[200px]">Input</Th>
              <Th className="min-w-[200px]">Output</Th>
              <Th className="min-w-[180px]">Expected</Th>
              {/* One column per scorer (e.g. no_conclusion, covers_both_cities). */}
              {scorerNames.map((name) => (
                <Th key={name} className="w-[130px] whitespace-nowrap text-right font-mono">
                  {name}
                </Th>
              ))}
              <Th className="w-[90px] text-right">Duration</Th>
              <Th className="w-[90px] text-right">Cost</Th>
            </TRHead>
          </THead>
          <TBody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columnCount}>
                  <p className="px-4 py-12 text-center text-[12px] text-muted-foreground">
                    {results.length === 0
                      ? "No per-case results reported for this run yet."
                      : "No results match this filter."}
                  </p>
                </td>
              </tr>
            ) : (
              visible.map((result) => (
                <TR
                  key={result.id}
                  interactive
                  selected={result.id === openResultId}
                  onClick={() => onOpen(result.id)}
                >
                  <Td className="max-w-[260px] truncate">{result.input}</Td>
                  <Td className="max-w-[260px]">
                    <span className="block truncate">
                      {result.candidateOutput ?? (
                        <span className="text-muted-foreground">No output</span>
                      )}
                    </span>
                  </Td>
                  <Td className="max-w-[220px] truncate text-muted-foreground">
                    {result.expectedOutput ?? "—"}
                  </Td>
                  {scorerNames.map((name) => {
                    const s = scoreFor(result, name);
                    return (
                      <Td
                        key={name}
                        className="whitespace-nowrap text-right text-[11px] tabular-nums"
                      >
                        {s ? scoreValue(s) : <span className="text-muted-foreground">—</span>}
                      </Td>
                    );
                  })}
                  <Td className="whitespace-nowrap text-right text-[11px] tabular-nums text-muted-foreground">
                    {fmtDurationMs(result.durationMs)}
                  </Td>
                  <Td className="whitespace-nowrap text-right text-[11px] tabular-nums text-muted-foreground">
                    {result.cost === null ? "—" : `$${result.cost.toFixed(4)}`}
                  </Td>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </div>
    </div>
  );
}
