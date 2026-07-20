"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ExpandableSection } from "@/components/ui/expandable-section";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { DATE_FILTER_OPTIONS, type DateFilterOption } from "@/lib/date-filter";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  EditableValueBlock,
  EvalPageHeader,
  EvalResultBadge,
  ReviewPanel,
  seedFormat,
  Timestamp,
  useSeedTraceIO,
  type ReviewTarget,
} from "@/features/offline-eval/components";
import { TraceViewerPanel } from "@/features/traces/components";
import { useTrace } from "@/features/traces/hooks";
import type { Span, TraceDetail } from "@/types/api";
import type { SpanKind, SpanStatus } from "@traceroot/core";
import { cn } from "@/lib/utils";
import {
  changeSentiment,
  pctFraction,
  SENTIMENT_CLASS,
  signed,
  signedPoints,
  truncate,
} from "@/features/offline-eval/utils";
import {
  useEvaluationRun,
  useEvaluationRuns,
  useCreateHumanScore,
  useUpdateTestCase,
} from "../hooks";
import { RunStatusBadge } from "./evaluations-view";
import { attributeTraceUsage, type TraceUsage, type UsageSpan } from "@/lib/eval/trace-usage";
import type { ResultRow, RunDetail, ScoreRow, Classification } from "../types";

/** Verdict → badge tone, matching the design system's success/danger/warning. */
const HUMAN_VERDICT_VARIANT: Record<string, "success" | "danger" | "warning"> = {
  pass: "success",
  fail: "danger",
  unsure: "warning",
};

/** Case/run duration; "Unknown" when unmeasured (never 0s). */
function fmtDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "Unknown";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Whether two authored values are the SAME value. A pure reformat (re-indenting
 * JSON, whether from the seed format or the format switcher) is not an edit —
 * without this, opening a case would offer to publish a new dataset version that
 * changes nothing but whitespace.
 */
export function sameAuthoredValue(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false; // one side isn't JSON — trust the text comparison above
  }
}

function scoreValue(s: ScoreRow): string {
  if (s.error) return "error";
  if (s.numericValue !== null) return String(s.numericValue);
  if (s.boolValue !== null) return s.boolValue ? "pass" : "fail";
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
 * trace viewer (span tree + span detail) exactly like the mock — the shape the
 * SDK reports:
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

  const spans: Span[] = [
    evalSpan({
      span_id: `${id}-root`,
      trace_id: id,
      name: `${run.evaluationName} · ${result.testCaseId}`,
      span_kind: "AGENT" as SpanKind,
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
      input: result.input,
      output: result.candidateOutput,
      cost: result.cost,
      status: rootStatus,
      status_message: result.taskError ?? null,
      metadata: JSON.stringify({ step: "task" }),
    }),
  ];

  // Scorer spans — siblings of the task, one per scorer that ran.
  for (const s of result.scores) {
    spans.push(
      evalSpan({
        span_id: `${id}-scorer-${s.id}`,
        trace_id: id,
        parent_span_id: `${id}-root`,
        name: s.scorerName,
        span_kind: "SPAN" as SpanKind,
        input: `output: ${result.candidateOutput ?? "—"}\nexpected: ${result.expectedOutput ?? "—"}`,
        output: s.error ?? scoreValue(s),
        status: (s.error ? "ERROR" : "OK") as SpanStatus,
        status_message: s.error ?? null,
        metadata: JSON.stringify({ scorer: s.scorerName, version: s.scorerVersion }),
      }),
    );
  }

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

type ResultFilterId =
  | "all"
  | "regressions"
  | "improvements"
  | "failed"
  | "errors"
  | "unpaired"
  | "not_scored";

const RESULT_FILTERS: Array<{ id: ResultFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "regressions", label: "Regressions" },
  { id: "improvements", label: "Improvements" },
  { id: "failed", label: "Failed" },
  { id: "errors", label: "Errors" },
  { id: "unpaired", label: "Unpaired" },
  { id: "not_scored", label: "Not scored" },
];

// Filters key on the DERIVED case verdict (comparison.caseChange), never the stored
// change column. "Unpaired" folds in not_comparable (paired but un-trustable) cases.
const RESULT_FILTER_FN: Record<ResultFilterId, (r: ResultRow) => boolean> = {
  all: () => true,
  regressions: (r) => r.comparison?.caseChange === "regressed",
  improvements: (r) => r.comparison?.caseChange === "improved",
  failed: (r) => r.status === "failed",
  errors: (r) => r.status === "errored" || r.scores.some((s) => s.error),
  unpaired: (r) =>
    r.comparison?.caseChange === "unpaired" || r.comparison?.caseChange === "not_comparable",
  not_scored: (r) => r.status === "not_scored",
};

/** Human-readable explanation of why a comparison is untrustworthy, from its reasons. */
function comparisonReasonText(reasons: string[], datasetVersionLabel: string): string {
  const parts: string[] = [];
  if (reasons.includes("different_dataset_version")) {
    parts.push(
      `the baseline measured a different dataset snapshot than this run (${datasetVersionLabel}), so the two runs covered different test cases`,
    );
  }
  if (reasons.includes("different_evaluation")) {
    parts.push("the baseline belongs to a different evaluation");
  }
  if (reasons.includes("baseline_not_terminal")) {
    parts.push("the baseline run has not finished, so its scores may still change");
  }
  if (reasons.includes("main_scorer_incompatible")) {
    parts.push(
      "the main scorer could not be compared on any shared case (missing or version-mismatched)",
    );
  }
  if (parts.length === 0) return "The selected baseline is not directly comparable.";
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("; ") + ".";
}

/**
 * Evaluation run detail — faithful port of the prototype's run detail, wired to
 * the server. Ordered to answer, in sequence: did the candidate improve, what
 * regressed, what broke, and can the aggregate be trusted? Verdict strip first
 * (its Regressions/Errors counts filter the results table in place), then the
 * results hero, then folded Regressions / Errors / Run details.
 *
 * Opening a result opens the REAL trace viewer (span tree + span detail) on an
 * eval-shaped trace built from the result, with the evaluation context, scores,
 * and human review as the span-actions panel — exactly like the mock.
 */
export function RunDetailView({ projectId, runId }: { projectId: string; runId: string }) {
  const { data, isLoading, error } = useEvaluationRun(projectId, runId);
  const [openResultId, setOpenResultId] = React.useState<string | null>(null);
  const [resultFilter, setResultFilter] = React.useState<ResultFilterId>("all");
  const [reviewOpen, setReviewOpen] = React.useState(false);

  const { toast } = useToast();
  const results = React.useMemo(() => data?.results ?? [], [data]);
  const run = data?.run;

  // This evaluation's other runs, for the breadcrumb's run switcher. Shares the
  // RunSwitcher's query key, so it's the same fetch, not a second one.
  const siblingRuns = useEvaluationRuns(projectId, {
    evaluation_id: run?.evaluationId,
    limit: 100,
  });
  const runOptions = React.useMemo(
    () =>
      run
        ? (siblingRuns.data?.data ?? []).map((r) => ({
            id: r.id,
            label: `#${r.runNumber} · ${r.candidateVersion}`,
            href: `/projects/${projectId}/evaluations/${r.id}`,
            isCurrent: r.id === run.id,
          }))
        : [],
    [siblingRuns.data, run, projectId],
  );

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

  const updateCase = useUpdateTestCase(projectId, run?.datasetId ?? "");
  const humanScore = useCreateHumanScore(projectId, openResult?.id ?? "");

  const panelTraceId = useRealTrace ? realTraceId : fallbackTrace?.trace_id;
  const panelOverride = useRealTrace ? undefined : fallbackTrace;

  // Token/cost derived from the OPEN result's real trace (already fetched — bounded, no
  // extra query). Pending while the reported trace ingests; the reconstructed fallback
  // has no LLM leaves so it reports "unknown", never a fabricated 0.
  const openTraceSpans = useRealTrace ? realTrace.data?.spans : panelOverride?.spans;
  const traceUsage = React.useMemo<TraceUsage>(
    () =>
      tracePending
        ? attributeTraceUsage(null)
        : attributeTraceUsage(openTraceSpans as UsageSpan[] | undefined),
    [tracePending, openTraceSpans],
  );

  const closeResult = () => setOpenResultId(null);

  // The trace panel's up/down chevrons step between this run's results (in the same
  // order + filter as the table), so you can walk case-by-case without closing it.
  const visibleResults = React.useMemo(
    () => results.filter(RESULT_FILTER_FN[resultFilter]),
    [results, resultFilter],
  );
  const openIndex = openResult ? visibleResults.findIndex((r) => r.id === openResult.id) : -1;
  const navigateResult = (dir: "up" | "down") => {
    if (openIndex === -1) return;
    const next = dir === "up" ? openIndex - 1 : openIndex + 1;
    if (next >= 0 && next < visibleResults.length) setOpenResultId(visibleResults[next].id);
  };

  return (
    <>
      <ProjectBreadcrumb
        projectId={projectId}
        trail={
          run
            ? [
                {
                  // Just the run segment (no separate "Evaluations" crumb) — a dropdown
                  // of this evaluation's runs. Its menu header still links to the
                  // Evaluations list, so that page stays one click away.
                  label: `${run.evaluationName} #${run.runNumber}`,
                  menuHeader: { label: "Evaluations", href: `/projects/${projectId}/evaluations` },
                  options: runOptions,
                },
              ]
            : undefined
        }
        current={run ? undefined : "Evaluations"}
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
          <RunBody
            projectId={projectId}
            run={data.run}
            results={results}
            filter={resultFilter}
            onFilterChange={setResultFilter}
            onOpenResult={setOpenResultId}
            openResultId={openResultId}
          />
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
          newTabPath={`/projects/${projectId}/evaluations/${runId}`}
          onClose={closeResult}
          onNavigate={navigateResult}
          canNavigateUp={openIndex > 0}
          canNavigateDown={openIndex >= 0 && openIndex < visibleResults.length - 1}
          spanActions={() => (
            <ResultContext
              projectId={projectId}
              run={run}
              result={openResult}
              traceUsage={traceUsage}
              onReview={() => setReviewOpen(true)}
              onSaveExpected={(value) =>
                updateCase.mutate(
                  {
                    testCaseId: openResult.testCaseId,
                    patch: { expected: value.trim() === "" ? null : value },
                  },
                  {
                    onSuccess: () =>
                      toast({
                        title: "Expected outcome saved — new dataset version published",
                        tone: "success",
                      }),
                  },
                )
              }
            />
          )}
          spanExtraTags={() => (
            <>
              {!useRealTrace && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-100/60 px-2.5 py-1 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
                  Reconstructed — no telemetry was emitted for this result
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs">
                <span className="text-muted-foreground">Evaluation:</span>
                <span className="font-medium">{run.evaluationName}</span>
                <span className="text-muted-foreground">
                  Run #{run.runNumber} · {run.candidateVersion}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs">
                <span className="text-muted-foreground">Snapshot:</span>
                <span className="font-medium">
                  {run.datasetName} · {run.datasetVersionLabel}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs">
                <span className="text-muted-foreground">Test case:</span>
                <span className="font-mono">{openResult.testCaseId}</span>
              </span>
            </>
          )}
        />
      )}

      {/* Human review of one output — scores it, never touches the dataset. */}
      <ReviewPanel
        target={
          openResult
            ? ({
                contextLabel: `${openResult.testCaseId} · ${run?.evaluationName} ${run?.candidateVersion}`,
                input: openResult.input,
                output: openResult.candidateOutput ?? "No output — the task errored.",
                expected: openResult.expectedOutput,
                autoScores: openResult.scores.map((s) => ({
                  name: `${s.scorerName} ${s.scorerVersion}`,
                  display: s.error ? "Scorer error" : scoreValue(s),
                  explanation: s.error ?? s.explanation ?? undefined,
                })),
                existing: undefined,
              } satisfies ReviewTarget)
            : null
        }
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onSave={(review) =>
          humanScore.mutate({
            verdict: review.verdict,
            quality: review.quality ?? null,
            comment: review.comment ?? null,
            reviewer: review.reviewer,
          })
        }
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

function RunBody({
  projectId,
  run,
  results,
  filter,
  onFilterChange,
  onOpenResult,
  openResultId,
}: {
  projectId: string;
  run: RunDetail;
  results: ResultRow[];
  filter: ResultFilterId;
  onFilterChange: (filter: ResultFilterId) => void;
  onOpenResult: (id: string) => void;
  openResultId: string | null;
}) {
  const router = useRouter();
  const hasBaseline = run.baselineRunId !== null;
  // Derived verdict — never the stored `change` column.
  const regressed = results.filter((r) => r.comparison?.caseChange === "regressed");
  const incompatibleBaseline = run.comparison.available && !run.comparison.trustworthy;
  const trustNote = comparisonReasonText(run.comparison.reasons, run.datasetVersionLabel);

  return (
    <>
      <EvalPageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>{run.evaluationName}</span>
            {/* The run being viewed is immutable; the candidate is what changed.
                The run number opens a switcher to this evaluation's other runs. */}
            <RunSwitcher
              projectId={projectId}
              run={run}
              onPick={(id) => router.push(`/projects/${projectId}/evaluations/${id}`)}
            />
            <Badge variant="foreground" className="font-mono text-[11px]">
              {run.candidateVersion}
            </Badge>
            <span className="font-mono text-xs font-normal text-muted-foreground">{run.id}</span>
            <CopyButton
              value={run.id}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              title="Copy run ID"
            />
          </span>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-3 p-4">
          {incompatibleBaseline && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Comparison not fully trustworthy.</span> {trustNote}{" "}
                The change is shown for context but should not be read as a clean verdict.
              </span>
            </div>
          )}

          {/* Verdict first, as a one-line strip — then results are the hero. */}
          <VerdictStrip run={run} onFilter={onFilterChange} />

          <ResultsSection
            results={results}
            hasBaseline={hasBaseline}
            filter={filter}
            onFilterChange={onFilterChange}
            onOpen={onOpenResult}
            openResultId={openResultId}
          />

          {/* Everything else folds below the results. */}
          {hasBaseline && regressed.length > 0 && (
            <ExpandableSection title={`Regressions (${regressed.length})`} defaultOpen={false}>
              <RegressionsList regressed={regressed} onOpen={onOpenResult} />
            </ExpandableSection>
          )}

          {run.errorCount > 0 && (
            <ExpandableSection title={`Errors (${run.errorCount})`} defaultOpen={false}>
              <ErrorsBody run={run} results={results} onOpen={onOpenResult} />
            </ExpandableSection>
          )}

          <ExpandableSection title="Run details" defaultOpen={false}>
            <RunDetailsBody run={run} projectId={projectId} />
          </ExpandableSection>
        </div>
      </div>
    </>
  );
}

/** Jump to another run of the same evaluation, newest first. */
function RunSwitcher({
  projectId,
  run,
  onPick,
}: {
  projectId: string;
  run: RunDetail;
  onPick: (runId: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const { data } = useEvaluationRuns(projectId, { evaluation_id: run.evaluationId, limit: 100 });
  const runs = React.useMemo(
    () => [...(data?.data ?? [])].sort((a, b) => b.runNumber - a.runNumber),
    [data],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-sm font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Run #{run.runNumber}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[320px] w-64 overflow-y-auto p-1">
        {runs.map((sibling) => (
          <button
            key={sibling.id}
            type="button"
            onClick={() => {
              onPick(sibling.id);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors",
              sibling.id === run.id ? "bg-muted/70" : "hover:bg-muted/50",
            )}
          >
            <span className="flex items-center gap-1.5">
              <span>Run #{sibling.runNumber}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {sibling.candidateVersion}
              </span>
            </span>
            <span className="tabular-nums text-muted-foreground">
              {sibling.mainScore === null ? "—" : pctFraction(sibling.mainScore)}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Compact verdict — the run's headline numbers on one strip, above the results.
 * Regressions and Errors are clickable: they filter the results table in place
 * rather than being separate sections the reader has to scroll past.
 */
function VerdictStrip({
  run,
  onFilter,
}: {
  run: RunDetail;
  onFilter: (filter: ResultFilterId) => void;
}) {
  const unscored = run.caseCount - run.scoredCount;
  const cmp = run.comparison;
  const cases = cmp.caseCounts;
  const cells = cmp.scoreCellCounts;
  // "Not cleanly compared" folds unpaired (one side only) + not_comparable (paired but
  // un-trustable). A delta and regression counts are shown only when a comparison is
  // available — otherwise "—" (unknown), never a delta beside a bare 0.
  const unpaired = cases.unpaired + cases.not_comparable;
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <RunStatusBadge status={run.status} />
        <Metric
          label={run.mainScoreName ?? "Main score"}
          value={run.mainScore === null ? "—" : pctFraction(run.mainScore)}
          hint={cmp.baseline ? `vs ${cmp.baseline.candidateVersion}` : undefined}
          strong
        />
        <Metric
          label="Change"
          value={
            !cmp.available || cmp.mainScore.delta === null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <span className={SENTIMENT_CLASS[changeSentiment(cmp.mainScore.delta)]}>
                {signedPoints(cmp.mainScore.delta)} pp
              </span>
            )
          }
          hint={!cmp.available ? "No baseline" : !cmp.trustworthy ? "Not trusted" : undefined}
        />
        {/* Case-level (main scorer). Regressions/Improvements filter the table. */}
        <FilterStat
          label="Regressed"
          count={cmp.available ? cases.regressed : null}
          onClick={() => onFilter("regressions")}
        />
        <FilterStat
          label="Improved"
          count={cmp.available ? cases.improved : null}
          onClick={() => onFilter("improvements")}
        />
        <Metric label="Unchanged" value={cmp.available ? cases.unchanged : "—"} />
        <FilterStat
          label="Unpaired"
          count={cmp.available ? unpaired : null}
          onClick={() => onFilter("unpaired")}
        />
        {/* Secondary, clearly labeled: regressed SCORE CELLS ≠ regressed cases. */}
        <Metric
          label="Regressed cells"
          value={cmp.available ? cells.regressed : "—"}
          hint="score cells"
        />
        <FilterStat label="Errors" count={run.errorCount} onClick={() => onFilter("errors")} />
        <Metric label="Scored" value={`${run.scoredCount} / ${run.caseCount}`} />
      </div>
      {/* Completeness — the denominator is always explicit. */}
      {unscored > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          <span className="text-foreground">
            {unscored} {unscored === 1 ? "case is" : "cases are"} not scored
          </span>{" "}
          — excluded from the average, not counted as zero.
        </p>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("tabular-nums", strong ? "text-[18px] font-medium" : "text-[15px]")}>
        {value}
      </p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A count that filters the results table when non-zero. A null count means the
 * quantity is UNKNOWN (e.g. no baseline → regressions can't be counted) and renders
 * as "—", never a bare 0 that would read as "0 regressions" beside a delta.
 */
function FilterStat({
  label,
  count,
  onClick,
}: {
  label: string;
  count: number | null;
  onClick: () => void;
}) {
  if (count === null) {
    return <Metric label={label} value={<span className="text-muted-foreground">—</span>} />;
  }
  if (count === 0) {
    return <Metric label={label} value={<span className="text-muted-foreground">0</span>} />;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      title={`Show ${label.toLowerCase()} in the results below`}
    >
      <span className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2">
        {label}
      </span>
      <span className="block text-[15px] font-medium tabular-nums">{count}</span>
    </button>
  );
}

const RESULT_COLUMN_COUNT = 6;

function ResultsSection({
  results,
  hasBaseline,
  filter,
  onFilterChange,
  onOpen,
  openResultId,
}: {
  results: ResultRow[];
  hasBaseline: boolean;
  filter: ResultFilterId;
  onFilterChange: (filter: ResultFilterId) => void;
  onOpen: (id: string) => void;
  openResultId: string | null;
}) {
  const { toast } = useToast();
  const [keyword, setKeyword] = React.useState("");
  const [sortWorst, setSortWorst] = React.useState(false);
  const [dateFilter, setDateFilter] = React.useState<DateFilterOption>(
    DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0],
  );
  const [customStart, setCustomStart] = React.useState<Date | null>(null);
  const [customEnd, setCustomEnd] = React.useState<Date | null>(null);

  const visible = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const filtered = results.filter((r) => {
      if (!RESULT_FILTER_FN[filter](r)) return false;
      if (!q) return true;
      return (
        r.input.toLowerCase().includes(q) ||
        (r.candidateOutput ?? "").toLowerCase().includes(q) ||
        (r.expectedOutput ?? "").toLowerCase().includes(q)
      );
    });
    if (!sortWorst) return filtered;
    // Worst main-score regression first (most-negative delta); unknown deltas last.
    return [...filtered].sort((a, b) => {
      const da = a.comparison?.mainScore.delta;
      const db = b.comparison?.mainScore.delta;
      if (da == null && db == null) return 0;
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    });
  }, [results, keyword, filter, sortWorst]);

  return (
    <div className="rounded-md border border-border">
      <SearchFilterBar
        searchInput={
          <div className="relative min-w-[10rem] max-w-md flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Search results..."
              className="h-7 pl-8 text-[12px]"
            />
          </div>
        }
        dateFilter={dateFilter}
        customStartDate={customStart}
        customEndDate={customEnd}
        onDateFilterChange={setDateFilter}
        onCustomRangeChange={(s, e) => {
          setCustomStart(s);
          setCustomEnd(e);
        }}
      >
        <div className="flex items-center gap-1">
          {RESULT_FILTERS.map((option) => (
            <Button
              key={option.id}
              variant={filter === option.id ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-[12px]"
              onClick={() => onFilterChange(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <span className="flex-1" aria-hidden />
        <Button
          variant={sortWorst ? "default" : "outline"}
          size="sm"
          className="h-7 gap-1.5 px-2 text-[12px]"
          onClick={() => setSortWorst((s) => !s)}
          title="Sort by the worst main-score regression first"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          Worst regression
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
          onClick={() => toast({ title: "Export coming soon", tone: "success" })}
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Download
        </Button>
      </SearchFilterBar>

      <Table>
        <THead>
          <TRHead>
            <Th>Input</Th>
            <Th>Output</Th>
            <Th>Expected</Th>
            <Th className="w-[170px]">Main score</Th>
            <Th className="w-[110px] text-right">Change</Th>
            <Th className="w-[110px]">Status</Th>
          </TRHead>
        </THead>
        <TBody>
          {visible.length === 0 ? (
            <tr>
              <td colSpan={RESULT_COLUMN_COUNT}>
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
                <Td>{truncate(result.input, 60)}</Td>
                <Td>
                  {result.candidateOutput ?? (
                    <span className="text-muted-foreground">No output</span>
                  )}
                </Td>
                <Td className="text-muted-foreground">{result.expectedOutput ?? "—"}</Td>
                <Td>
                  <MainScoreCell result={result} hasBaseline={hasBaseline} />
                </Td>
                <Td className="text-right">
                  <ChangeCell
                    change={hasBaseline ? (result.comparison?.caseChange ?? null) : null}
                  />
                </Td>
                <Td>
                  <EvalResultBadge status={result.status} />
                </Td>
              </TR>
            ))
          )}
        </TBody>
      </Table>
    </div>
  );
}

/**
 * Per-result candidate main score, its baseline counterpart, and the delta — the
 * backend now derives the baseline per-case value, so we show a real magnitude, not
 * just a direction. Missing values render "—", never a fabricated 0.
 */
function MainScoreCell({ result, hasBaseline }: { result: ResultRow; hasBaseline: boolean }) {
  const cmp = result.comparison;
  const cand = cmp?.mainScore.candidate ?? result.mainScore;
  if (cand === null || cand === undefined) return <span className="text-muted-foreground">—</span>;
  const base = hasBaseline ? (cmp?.mainScore.baseline ?? null) : null;
  const delta = hasBaseline ? (cmp?.mainScore.delta ?? null) : null;
  return (
    <div className="flex flex-col gap-0.5 text-[12px] tabular-nums">
      <span>
        {pctFraction(cand)}
        {base !== null && <span className="text-muted-foreground"> vs {pctFraction(base)}</span>}
      </span>
      {delta !== null && (
        <span className={SENTIMENT_CLASS[changeSentiment(delta)]}>{signedPoints(delta)} pp</span>
      )}
    </div>
  );
}

/** Per-result case verdict (derived from the main scorer), faithfully rendered. */
function ChangeCell({ change }: { change: Classification | null }) {
  if (change === "improved") {
    return (
      <span
        className={cn("inline-flex items-center justify-end gap-0.5", SENTIMENT_CLASS.good)}
        title="Improved"
      >
        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
        Improved
      </span>
    );
  }
  if (change === "regressed") {
    return (
      <span
        className={cn("inline-flex items-center justify-end gap-0.5", SENTIMENT_CLASS.bad)}
        title="Regressed"
      >
        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
        Regressed
      </span>
    );
  }
  if (change === "changed") {
    return <span title="Changed (categorical)">Changed</span>;
  }
  if (change === "unchanged") {
    return <span className="text-muted-foreground">Unchanged</span>;
  }
  if (change === "unpaired" || change === "not_comparable") {
    return (
      <span className="text-muted-foreground" title="Not compared against a baseline value">
        {change === "unpaired" ? "Unpaired" : "Not comparable"}
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function cellValueDisplay(v: number | boolean | string | null): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return v;
}

const CELL_CLASS_STYLE: Record<Classification, { label: string; className: string }> = {
  improved: { label: "Improved", className: SENTIMENT_CLASS.good },
  regressed: { label: "Regressed", className: SENTIMENT_CLASS.bad },
  unchanged: { label: "Unchanged", className: "text-muted-foreground" },
  changed: { label: "Changed", className: "text-foreground" },
  unpaired: { label: "Unpaired", className: "text-muted-foreground" },
  not_comparable: { label: "Not comparable", className: "text-amber-600 dark:text-amber-400" },
};

/**
 * The candidate-vs-baseline breakdown per scorer cell, shown beside the trace. Uses
 * the derived comparison (candidate value, baseline value, delta or transition, and the
 * cell classification + reason); falls back to candidate-only scores when there is no
 * comparison (no baseline). A failed scorer is an error, never a 0.
 */
function ScorerBreakdown({ result }: { result: ResultRow }) {
  const cells = result.comparison?.scorerCells ?? [];
  const byName = new Map(result.scores.map((s) => [s.scorerName, s]));

  if (cells.length === 0) {
    if (result.scores.length === 0) return null;
    return (
      <ul className="mt-2 divide-y divide-border rounded border border-border">
        {result.scores.map((s) => (
          <li key={s.id} className="px-2.5 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {s.scorerName}
                <span className="ml-1.5 font-normal text-muted-foreground">{s.scorerVersion}</span>
              </span>
              {s.error ? (
                <Badge variant="warning">Scorer error</Badge>
              ) : (
                <span className="tabular-nums">{scoreValue(s)}</span>
              )}
            </div>
            {s.explanation && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {s.explanation}
              </p>
            )}
            {s.error && (
              <p className="mt-0.5 font-mono text-[11px] text-amber-700 dark:text-amber-400">
                {s.error} — the candidate answered, only the judge failed.
              </p>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="mt-2 divide-y divide-border rounded border border-border">
      {cells.map((c) => {
        const s = byName.get(c.scorerName);
        const style = CELL_CLASS_STYLE[c.classification];
        return (
          <li key={c.scorerName} className="px-2.5 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {c.scorerName}
                <span className="ml-1.5 font-normal text-muted-foreground">{c.scorerVersion}</span>
              </span>
              <span className={cn("text-[11px] font-medium", style.className)}>{style.label}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
              <span>
                candidate{" "}
                <span className="text-foreground">{cellValueDisplay(c.candidateValue)}</span>
              </span>
              <span>
                baseline{" "}
                <span className="text-foreground">{cellValueDisplay(c.baselineValue)}</span>
              </span>
              {c.delta !== null && (
                <span className={SENTIMENT_CLASS[changeSentiment(c.delta)]}>{signed(c.delta)}</span>
              )}
              {c.transition && (
                <span className="text-foreground">
                  {c.transition.from} → {c.transition.to}
                </span>
              )}
              {c.reason && (
                <span className="text-amber-600 dark:text-amber-400">
                  {c.reason.replace(/_/g, " ")}
                </span>
              )}
            </div>
            {s?.explanation && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {s.explanation}
              </p>
            )}
            {s?.error && (
              <p className="mt-0.5 font-mono text-[11px] text-amber-700 dark:text-amber-400">
                {s.error} — the candidate answered, only the judge failed.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Trace-derived token/cost for the open case, split by application (task) vs
 * evaluation-judge (scorers). `pending` while the trace ingests, `unknown` when the
 * trace carries no provider usage — a real 0 only when the trace proves it.
 */
function UsageBreakdown({ usage }: { usage: TraceUsage }) {
  if (usage.state === "pending") {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        Tokens &amp; cost: <span className="text-foreground">pending</span> — the case trace is
        still ingesting.
      </p>
    );
  }
  if (usage.state === "unknown") {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        Tokens &amp; cost: <span className="text-foreground">unknown</span> — the trace reported no
        provider usage.
      </p>
    );
  }
  const fmtCost = (c: number) => (c > 0 ? `$${c.toFixed(4)}` : "$0");
  const rows = [
    { label: "Application (task)", b: usage.task },
    { label: "Evaluation judge (scorers)", b: usage.scorer },
    { label: "Other", b: usage.other },
  ].filter((r) => r.b.spanCount > 0);
  return (
    <div className="mt-2 overflow-hidden rounded border border-border">
      <div className="border-b border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
        Tokens &amp; cost (from the trace)
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between px-2.5 py-1 text-[11px]">
            <span className="text-muted-foreground">{r.label}</span>
            <span className="tabular-nums">
              {r.b.totalTokens.toLocaleString()} tok · {fmtCost(r.b.cost)}
            </span>
          </li>
        ))}
        <li className="flex items-center justify-between bg-muted/20 px-2.5 py-1 text-[11px] font-medium">
          <span>Combined</span>
          <span className="tabular-nums">
            {usage.combined.totalTokens.toLocaleString()} tok · {fmtCost(usage.combined.cost)}
          </span>
        </li>
      </ul>
    </div>
  );
}

/** The regressed cases, as a plain list; the caller wraps it in a section. */
function RegressionsList({
  regressed,
  onOpen,
}: {
  regressed: ResultRow[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="-mx-2.5 -my-2 divide-y divide-border">
      {regressed.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onOpen(r.id)}
          className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/40"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate">{truncate(r.input, 90)}</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              was <span className="text-foreground">{r.baselineOutput ?? "—"}</span> · now{" "}
              <span className="text-foreground">{r.candidateOutput ?? "—"}</span> · expected{" "}
              <span className="text-foreground">{r.expectedOutput ?? "—"}</span>
            </span>
          </span>
          <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** Task errors and scorer errors are different failures and read differently. */
function ErrorsBody({
  run,
  results,
  onOpen,
}: {
  run: RunDetail;
  results: ResultRow[];
  onOpen: (id: string) => void;
}) {
  const taskErrors = results.filter((r) => r.taskError);
  const scorerErrors = results.filter((r) => r.scores.some((s) => s.error));
  return (
    <div className="flex flex-col gap-3">
      <ErrorGroup
        title={`Application errors (${run.taskErrorCount})`}
        blurb="The candidate application failed for these test cases, so there is no output to judge."
        rows={taskErrors.map((r) => ({ id: r.id, input: r.input, detail: r.taskError ?? "" }))}
        onOpen={onOpen}
      />
      <ErrorGroup
        title={`Scorer errors (${run.scorerErrorCount})`}
        blurb="The candidate produced an output, but a scorer failed to judge it. These cases are unscored."
        rows={scorerErrors.map((r) => ({
          id: r.id,
          input: r.input,
          detail: r.scores
            .filter((s) => s.error)
            .map((s) => `${s.scorerName}: ${s.error}`)
            .join(" · "),
        }))}
        onOpen={onOpen}
      />
    </div>
  );
}

function ErrorGroup({
  title,
  blurb,
  rows,
  onOpen,
}: {
  title: string;
  blurb: string;
  rows: Array<{ id: string; input: string; detail: string }>;
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[12px] font-medium">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
        {title}
      </p>
      <p className="mb-1.5 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{blurb}</p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">None.</p>
      ) : (
        <ul className="divide-y divide-border rounded border border-border">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onOpen(row.id)}
                className="flex w-full flex-col items-start px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
              >
                <span className="truncate">{truncate(row.input, 80)}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{row.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Run configuration + immutable identities; caller wraps in a section.
 * The prototype also showed a baseline picker and duration/cost/token totals.
 * The baseline is server-computed against a fixed baselineRunId (no endpoint to
 * repoint it), so it is read-only here; the aggregate metrics are not persisted
 * on a run, so those rows are omitted rather than fabricated.
 */
function RunDetailsBody({ run, projectId }: { run: RunDetail; projectId: string }) {
  return (
    <div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <Row label="Candidate version">
          <span className="font-mono">{run.candidateVersion}</span>
        </Row>
        <Row label="Dataset">
          <Link
            href={`/projects/${projectId}/datasets/${run.datasetId}`}
            className="inline-flex items-center gap-1 rounded hover:underline"
          >
            {run.datasetName ?? run.datasetId}
            <span className="text-muted-foreground">· {run.datasetVersionLabel}</span>
          </Link>
        </Row>
        <Row label="Environment">{run.environment}</Row>
        <Row label="Started">
          <Timestamp iso={run.startedAt} className="inline" />
        </Row>
        {/* Run wall-clock (completedAt − startedAt), NOT the sum of case durations. */}
        <Row label="Run elapsed">{fmtDurationMs(run.elapsedMs)}</Row>
        {run.comparison.duration.pairedCount > 0 && (
          <Row label="Avg case duration">
            <span title="Mean per-case wall-clock (task + scorers), not run elapsed">
              {fmtDurationMs(run.comparison.duration.candidateMeanMs)}
              {run.comparison.duration.baselineMeanMs !== null && (
                <span className="text-muted-foreground">
                  {" "}
                  vs {fmtDurationMs(run.comparison.duration.baselineMeanMs)}
                </span>
              )}
              {run.comparison.duration.deltaMs !== null && (
                <span
                  className={cn(
                    "ml-1",
                    SENTIMENT_CLASS[changeSentiment(-run.comparison.duration.deltaMs)],
                  )}
                >
                  ({signed(run.comparison.duration.deltaMs / 1000)}s)
                </span>
              )}
            </span>
          </Row>
        )}
        <Row label="Scorers">
          {run.scorers && run.scorers.length > 0
            ? run.scorers.map((s) => `${s.name} ${s.version}`).join(", ")
            : "—"}
        </Row>
        <Row label="Baseline">
          {run.baselineRunId ? (
            <Link
              href={`/projects/${projectId}/evaluations/${run.baselineRunId}`}
              className="font-mono text-[11px] hover:underline"
            >
              {run.baselineRunId}
            </Link>
          ) : (
            "No baseline"
          )}
        </Row>
        <Row label="Evaluation ID">
          <span className="font-mono text-[11px]">{run.evaluationId}</span>
        </Row>
        <Row label="Run ID">
          <span className="font-mono text-[11px]">{run.id}</span>
        </Row>
        <Row label="Dataset snapshot ID">
          <span className="font-mono text-[11px]">{run.datasetVersionId}</span>
        </Row>
        {run.model && (
          <Row label="Model">
            <span className="font-mono text-[11px]">{run.model}</span>
          </Row>
        )}
      </dl>
      <ProvenanceBlock metadata={run.metadata} />
    </div>
  );
}

// Keys that may carry secrets/env — never rendered (informational safety, per spec).
const SECRET_KEY_RE = /secret|token|password|api[_-]?key|credential|\benv\b|authorization/i;

/**
 * Structured run provenance (model, prompt, config, git) as SECONDARY detail. Free-form
 * and optional: when absent it's an informational "not recorded" line, never an error.
 * The candidate label stays the primary identity (shown in the header). Env vars and
 * secret-looking keys are redacted; git repo/ref/commit are surfaced when present.
 */
function ProvenanceBlock({ metadata }: { metadata: Record<string, unknown> | null }) {
  const entries = metadata ? Object.entries(metadata).filter(([k]) => !SECRET_KEY_RE.test(k)) : [];
  const git =
    metadata && typeof metadata.git === "object" && metadata.git !== null
      ? (metadata.git as Record<string, unknown>)
      : null;

  return (
    <div className="mt-3 border-t border-border/50 pt-2">
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">Provenance</p>
      {entries.length === 0 && !git ? (
        <p className="text-[11px] text-muted-foreground">
          No provenance recorded for this run — informational only, not an error.
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          {git && (
            <Row label="Git">
              <span className="font-mono text-[11px]">
                {[git.repo, git.ref ?? git.commit].filter(Boolean).join(" @ ") || "—"}
              </span>
            </Row>
          )}
          {entries
            .filter(([k]) => k !== "git")
            .map(([k, v]) => (
              <Row key={k} label={k}>
                <span className="font-mono text-[11px]">
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </span>
              </Row>
            ))}
        </dl>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-1 last:border-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-right text-[12px]">{children}</dd>
    </div>
  );
}

/**
 * The evaluation context for one result, shown as the trace viewer's span-actions
 * panel. The input/candidate output already render in the span detail below, so
 * this adds only the eval-specific bits: the editable expected outcome (behind a
 * button; saving publishes a new dataset version), the scores, what broke, the
 * human review, and the actions.
 */
function ResultContext({
  projectId,
  run,
  result,
  traceUsage,
  onReview,
  onSaveExpected,
}: {
  projectId: string;
  run: RunDetail;
  result: ResultRow;
  traceUsage: TraceUsage;
  onReview: () => void;
  onSaveExpected: (value: string) => void;
}) {
  // Seed the canonical (expanded) form here rather than letting the field
  // normalise it: this component re-seeds `expected` from the prop whenever the
  // open result changes, which would otherwise clobber the field's own fix-up.
  const expectedValue = result.expectedOutput ?? "";
  const seededExpected = React.useMemo(
    () => seedFormat(expectedValue, "expanded").text,
    [expectedValue],
  );
  const [expected, setExpected] = React.useState(seededExpected);
  React.useEffect(() => setExpected(seededExpected), [seededExpected, result.id]);
  // Saving publishes a NEW dataset version, so only a real change counts as dirty:
  // re-indenting a value (by the seed format, or the format switcher) is not an edit.
  const expectedDirty = !sameAuthoredValue(expected, expectedValue);

  return (
    <div className="w-full text-[12px]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <EvalResultBadge status={result.status} />
        <span className="font-mono text-[11px] text-muted-foreground">{result.testCaseId}</span>
      </div>

      {/* Expected outcome — the same editable, format-aware value block used on the
          dataset case panel; Save (shown when edited) publishes a new dataset version. */}
      <div>
        <EditableValueBlock
          key={result.id}
          label="Expected outcome"
          text={expected}
          onChange={setExpected}
          boxed
          // The value candidate output is graded against, read closely and edited
          // here → expand it, like Input/Recorded output in Save as test case.
          seedJson="expanded"
          copyable
          minRows={2}
        />
        {expectedDirty && (
          <div className="mt-1.5 flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => onSaveExpected(expected.trim())}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => setExpected(expectedValue)}
            >
              Cancel
            </Button>
          </div>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          Saving edits test case <span className="font-mono">{result.testCaseId}</span> in{" "}
          <span className="font-medium">{run.datasetName}</span> — it changes what future runs are
          compared against.
        </p>
      </div>

      {result.baselineOutput !== null && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Baseline output: <span className="text-foreground">{result.baselineOutput}</span>
        </p>
      )}

      {/* An application error means no scorer ever ran. */}
      {result.taskError && (
        <div className="mt-2 rounded border border-red-300 bg-red-50 px-2.5 py-1.5 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-[11px] font-medium text-red-700 dark:text-red-300">
            Application error — the candidate failed, so no scorer ran
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-red-700 dark:text-red-300">
            {result.taskError}
          </p>
        </div>
      )}

      <ScorerBreakdown result={result} />

      <UsageBreakdown usage={traceUsage} />

      {result.humanScores.length > 0 && (
        <div className="mt-2 overflow-hidden rounded border border-border">
          <div className="border-b border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
            Human review
          </div>
          <ul className="divide-y divide-border">
            {result.humanScores.map((h) => (
              <li key={h.id} className="flex flex-col gap-1 px-2.5 py-1.5 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={HUMAN_VERDICT_VARIANT[h.verdict] ?? "default"}>
                    <span className="capitalize">{h.verdict}</span>
                  </Badge>
                  {h.quality != null && (
                    <span className="tabular-nums text-muted-foreground">
                      Quality {h.quality}/5
                    </span>
                  )}
                  {h.reviewer && (
                    <span className="ml-auto truncate text-muted-foreground">{h.reviewer}</span>
                  )}
                </div>
                {h.comment && <p className="leading-relaxed text-muted-foreground">{h.comment}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7 text-[12px]" onClick={onReview}>
          Review output
        </Button>
        <Link
          href={`/projects/${projectId}/datasets/${run.datasetId}?case=${result.testCaseId}`}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Database className="h-3.5 w-3.5" aria-hidden />
          View source test case
        </Link>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          {/* Candidate case duration vs baseline; "Unknown" when unmeasured, never 0. */}
          <span title="Case duration (task + scorers)">{fmtDurationMs(result.durationMs)}</span>
          {result.comparison?.baselineDurationMs != null && (
            <span>vs {fmtDurationMs(result.comparison.baselineDurationMs)}</span>
          )}
          {result.comparison?.durationDeltaMs != null && (
            <span className={SENTIMENT_CLASS[changeSentiment(-result.comparison.durationDeltaMs)]}>
              ({signed(result.comparison.durationDeltaMs / 1000)}s)
            </span>
          )}
          {result.cost !== null ? <span>· ${result.cost.toFixed(4)}</span> : ""}
        </span>
      </div>
    </div>
  );
}
