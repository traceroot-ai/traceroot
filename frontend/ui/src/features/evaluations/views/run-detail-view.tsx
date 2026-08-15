"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Database,
  GitCompare,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  EvalPageHeader,
  EvalResultBadge,
  ReviewPanel,
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
  signedPoints,
} from "@/features/offline-eval/utils";
import { useEvaluationRun, useEvaluationRuns, useCreateHumanScore, useCompareRuns } from "../hooks";
import { PullCodeDrawer } from "../components/pull-code-drawer";
import { PassRate } from "../components/pass-rate";
import { SaveTestCaseDrawer } from "../components/trace-integration";
import {
  SaveResultToDatasetDrawer,
  type ResultDatasetAction,
} from "../components/save-result-to-dataset-drawer";
import { reproduceRunCode, reproduceRunCodeTs } from "@/features/offline-eval/utils";
import { matchSpans } from "@/lib/eval/span-match";
import { attributeTraceUsage, type UsageSpan } from "@/lib/eval/trace-usage";
import { ComparabilityBanner } from "@/features/evaluations/components/comparability-banner";
import { ResultUsageSummary } from "@/features/evaluations/components/result-usage-summary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ResultRow,
  RunDetail,
  ScoreRow,
  Classification,
  CompareResultRow,
  CompareRunsResponse,
  ResultRowComparison,
  HumanScoreRow,
  HumanReviewSummary,
} from "../types";
import { HUMAN_VERDICT_LABEL, type HumanReview, type HumanVerdict } from "@/features/offline-eval/types";

/** The single canonical dimension reviewed in V1. */
const REVIEW_DIMENSION = "overall";

/**
 * Map the read-model review row a result carries into the panel's `HumanReview`
 * shape, so re-opening the review drawer pre-fills the saved verdict/quality/comment
 * instead of a blank form (nulls → undefined; the review's `updateTime` is its `at`).
 */
function toExistingReview(humanScores: HumanScoreRow[]): HumanReview | undefined {
  const saved =
    humanScores.find((h) => h.dimension === REVIEW_DIMENSION) ?? humanScores[0];
  return saved
    ? {
        verdict: saved.verdict as HumanVerdict,
        quality: saved.quality ?? undefined,
        comment: saved.comment ?? undefined,
        reviewer: saved.reviewer,
        at: saved.updateTime,
      }
    : undefined;
}

/** Case/run duration; "Unknown" when unmeasured (never 0s). */
function fmtDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "Unknown";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Signed candidate−baseline delta beside a duration/cost cell (lower is better:
 *  an increase is red, a decrease green). Rendered only when comparing. */
function CellDelta({
  delta,
  format,
}: {
  delta: number | null;
  format: (n: number) => string;
}): React.ReactNode {
  if (delta === null) return null;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return (
    <span className={`ml-1 ${SENTIMENT_CLASS[changeSentiment(-delta)]}`}>
      {sign}
      {format(Math.abs(delta))}
    </span>
  );
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

type ResultFilterId =
  | "all"
  | "regressions"
  | "improvements"
  | "failed"
  | "errors"
  | "unpaired"
  | "not_scored"
  | "needs_human_review"
  | "human_reviewed"
  | "judge_disagreement";

const RESULT_FILTERS: Array<{ id: ResultFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "regressions", label: "Regressions" },
  { id: "improvements", label: "Improvements" },
  { id: "failed", label: "Did not pass" },
  { id: "errors", label: "Errors" },
  { id: "unpaired", label: "Unpaired" },
  { id: "not_scored", label: "Not scored" },
  { id: "needs_human_review", label: "Needs human review" },
  { id: "human_reviewed", label: "Reviewed" },
  { id: "judge_disagreement", label: "Judge disagreement" },
];

/** The result's canonical human review (V1: the "overall" dimension), if any. */
function resultReview(r: ResultRow): HumanScoreRow | undefined {
  const reviews = r.humanScores ?? [];
  return reviews.find((h) => h.dimension === REVIEW_DIMENSION) ?? reviews[0];
}

/**
 * A human pass/fail verdict disagreeing with the automated pass/fail — both must be
 * boolean, so "unsure" and a quality-only review never count (mirrors the backend
 * `deriveHumanReviewSummary`). Read-only: this never alters the automated score.
 */
function isJudgeDisagreement(r: ResultRow): boolean {
  const review = resultReview(r);
  if (!review || (review.verdict !== "pass" && review.verdict !== "fail")) return false;
  const automatedPass = r.status === "passed" ? true : r.status === "failed" ? false : null;
  if (automatedPass === null) return false;
  return (review.verdict === "pass") !== automatedPass;
}

/** Compact human-review chip for the result drawer — verdict/quality/reviewer, plus a
 *  disagreement flag. Never renders the automated score; it sits beside it. */
function ReviewTag({
  review,
  disagreement,
}: {
  review: HumanScoreRow | undefined;
  disagreement: boolean;
}) {
  if (!review) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs">
        <span className="text-muted-foreground">Human review:</span>
        <span className="font-medium text-muted-foreground">Pending</span>
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
        disagreement
          ? "border-amber-400/60 bg-amber-100/50 dark:border-amber-700/60 dark:bg-amber-950/30"
          : "bg-muted/40"
      }`}
    >
      <span className="text-muted-foreground">Human review:</span>
      <span className="font-medium">{HUMAN_VERDICT_LABEL[review.verdict as HumanVerdict]}</span>
      {review.quality != null && <span className="text-muted-foreground">· {review.quality}/5</span>}
      <span className="text-muted-foreground">· {review.reviewer}</span>
      {disagreement && (
        <span className="font-medium text-amber-700 dark:text-amber-400">
          · Disagrees with automated
        </span>
      )}
    </span>
  );
}

// The comparison the case filters (and the table's Change cell) key on: the picked
// baseline when one is selected, else the result's own stored-baseline comparison. The
// two MUST agree — the run's stored `comparison` is null unless the run declared a
// baseline, so keying Regressions/Improvements on it shows nothing while a baseline is
// picked, even though the table renders the picked baseline's diff.
function activeComparison(
  r: ResultRow,
  compareByCase: Map<string, CompareResultRow> | null,
): ResultRow["comparison"] {
  return compareByCase?.get(r.testCaseId)?.comparison ?? r.comparison ?? null;
}

// Filters key on the DERIVED case verdict (comparison.caseChange), never the stored
// change column. "Unpaired" folds in not_comparable (paired but un-trustable) cases.
const RESULT_FILTER_FN: Record<
  ResultFilterId,
  (r: ResultRow, cmp: ResultRow["comparison"]) => boolean
> = {
  all: () => true,
  regressions: (_r, cmp) => cmp?.caseChange === "regressed",
  improvements: (_r, cmp) => cmp?.caseChange === "improved",
  failed: (r) => r.status === "failed",
  errors: (r) => r.status === "errored" || r.scores.some((s) => s.error),
  unpaired: (_r, cmp) => cmp?.caseChange === "unpaired" || cmp?.caseChange === "not_comparable",
  not_scored: (r) => r.status === "not_scored",
  needs_human_review: (r) => !resultReview(r),
  human_reviewed: (r) => !!resultReview(r),
  judge_disagreement: isJudgeDisagreement,
};

/**
 * Evaluation run detail — the run detail surface, wired to
 * the server. Ordered to answer, in sequence: did the candidate improve, what
 * regressed, what broke, and can the aggregate be trusted? Verdict strip first
 * (its Regressions/Errors counts filter the results table in place), then the
 * results hero, then folded Regressions / Errors / Run details.
 *
 * Opening a result opens the REAL trace viewer (span tree + span detail) on an
 * eval-shaped trace built from the result, with the evaluation context, scores,
 * and human review as the span-actions panel.
 */
export function RunDetailView({ projectId, runId }: { projectId: string; runId: string }) {
  const { data, isLoading, error } = useEvaluationRun(projectId, runId);
  const [openResultId, setOpenResultId] = React.useState<string | null>(null);
  const [resultFilter, setResultFilter] = React.useState<ResultFilterId>("all");
  const [reviewOpen, setReviewOpen] = React.useState(false);
  // "Save as test case" drawer (only for real ingested traces): which span it targets.
  const [saveTestCaseOpen, setSaveTestCaseOpen] = React.useState(false);
  const [saveTestCaseSpanId, setSaveTestCaseSpanId] = React.useState<string | undefined>(undefined);
  // Result→dataset drawer: which action the "Add to dataset" menu picked (null = closed).
  const [resultDatasetAction, setResultDatasetAction] = React.useState<ResultDatasetAction | null>(
    null,
  );
  // "Compare with" — another run of the SAME evaluation, chosen inline. The current run
  // is the candidate; the picked run is the baseline. Comparison is computed on demand
  // by the backend engine (the SDK no longer declares baselines).
  const [compareId, setCompareId] = React.useState<string | null>(null);

  const results = React.useMemo(() => data?.results ?? [], [data]);
  const run = data?.run;

  // On-demand comparison of this run (candidate) vs the picked run (baseline), from the
  // same backend engine + route the compare page uses — no second implementation.
  const compare = useCompareRuns(projectId, runId, compareId);
  const comparing = !!compareId && !!compare.data;
  const compareByCase = React.useMemo(() => {
    const m = new Map<string, CompareResultRow>();
    for (const c of compare.data?.results ?? []) m.set(c.testCaseId, c);
    return m;
  }, [compare.data]);

  const openResult = openResultId ? (results.find((r) => r.id === openResultId) ?? null) : null;
  const openCompareRow = openResult ? (compareByCase.get(openResult.testCaseId) ?? null) : null;

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

  const humanScore = useCreateHumanScore(projectId, openResult?.id ?? "");

  const panelTraceId = useRealTrace ? realTraceId : fallbackTrace?.trace_id;
  const panelOverride = useRealTrace ? undefined : fallbackTrace;

  const openTraceSpans = useRealTrace ? realTrace.data?.spans : panelOverride?.spans;

  // Per-result usage split (candidate task vs evaluation-judge overhead), trace-derived
  // and reliable per result — so it lives in this drawer, not as a run-level aggregate.
  // A reconstructed trace (no real telemetry) has no usage to attribute, so this stays
  // pending/unknown there rather than reporting a fabricated split.
  const resultUsage = React.useMemo(
    () => attributeTraceUsage(useRealTrace ? (openTraceSpans as UsageSpan[] | undefined) : null),
    [useRealTrace, openTraceSpans],
  );

  // The baseline case's trace (from the picked compare run), fetched so the trace
  // viewer's Diff toggle can diff each span (I/O, metadata, latency/token/cost) against
  // its baseline counterpart. Span ids differ across runs, so we match structurally
  // (kind + name + sibling index) once the baseline trace is loaded. Suppressed when
  // the candidate side is itself reconstructed (no real telemetry) — its timestamps are
  // fake placeholders, so diffing it against a real baseline trace would produce
  // fabricated latency deltas instead of an honest "unknown".
  const baselineTraceId =
    comparing && useRealTrace ? (openCompareRow?.baselineTraceId ?? null) : null;
  const baselineTrace = useTrace(projectId, baselineTraceId ?? "", !!baselineTraceId);
  const baselineSpanMatch = React.useMemo(() => {
    const baseSpans = baselineTrace.data?.spans;
    if (!openTraceSpans?.length || !baseSpans?.length) return null;
    return matchSpans(openTraceSpans, baseSpans);
  }, [openTraceSpans, baselineTrace.data]);

  const closeResult = () => setOpenResultId(null);

  // The trace panel's up/down chevrons step between this run's results (in the same
  // order + filter as the table), so you can walk case-by-case without closing it.
  const visibleResults = React.useMemo(
    () =>
      results.filter((r) =>
        RESULT_FILTER_FN[resultFilter](r, activeComparison(r, compareByCase)),
      ),
    [results, resultFilter, compareByCase],
  );
  const openIndex = openResult ? visibleResults.findIndex((r) => r.id === openResult.id) : -1;
  const navigateResult = (dir: "up" | "down") => {
    if (openIndex === -1) return;
    const next = dir === "up" ? openIndex - 1 : openIndex + 1;
    if (next >= 0 && next < visibleResults.length) setOpenResultId(visibleResults[next].id);
  };

  return (
    <>
      <ProjectBreadcrumb projectId={projectId} />
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
            compareId={compareId}
            onCompareChange={setCompareId}
            compareData={compare.data ?? null}
            compareLoading={!!compareId && compare.isLoading}
            compareByCase={comparing ? compareByCase : null}
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
          // The test case is the identity that matters across runs (a trace id is
          // per-execution, and synthetic when nothing was ingested), so the header
          // leads with it instead of the trace id.
          headerIdentity={{ label: "Test case", value: openResult.testCaseId }}
          // The case's outcome, in the header's findings-alert slot.
          headerStatus={<EvalResultBadge status={openResult.status} />}
          // With a compare run picked, open straight into diff mode against its matching
          // case (the user chose to compare — don't make them toggle it on per trace).
          defaultDiffOn={comparing}
          // While the "Save as test case" drawer is open, clicking a different span
          // retargets it to that span.
          onSelectionChange={(selection) => {
            if (saveTestCaseOpen) {
              setSaveTestCaseSpanId(selection.type === "span" ? selection.span.span_id : undefined);
            }
          }}
          // The case actions live in the span panel's header-section bar, directly
          // above the I/O — human review, the source test case, and (for a real
          // ingested trace) saving the selected span as a new test case. Everything
          // else that used to sit above the I/O has moved to the run detail table
          // and the trace header.
          spanActions={(selection) => (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                onClick={() => setReviewOpen(true)}
              >
                {resultReview(openResult) ? "Edit review" : "Review output"}
              </Button>
              <Link
                href={`/projects/${projectId}/datasets/${run.datasetId}?case=${openResult.testCaseId}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Database className="h-3.5 w-3.5" aria-hidden />
                View source test case
              </Link>
              {/* Result → dataset: the three case-level actions live under one menu.
                  Saving/duplicating/updating operates on the RESULT (its whole
                  candidate output for this case), publishing a new immutable dataset
                  version; the finer "save a specific span" capture stays available
                  below for real ingested traces. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-[12px]">
                    <Database className="h-3.5 w-3.5" aria-hidden />
                    Add to dataset
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuItem onSelect={() => setResultDatasetAction("update_existing_case")}>
                    <div>
                      <div className="text-[12px] font-medium">Update source case</div>
                      <div className="text-[11px] text-muted-foreground">
                        Publish a new version of this case
                      </div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setResultDatasetAction("save_new_case")}>
                    <div>
                      <div className="text-[12px] font-medium">Save as a new case</div>
                      <div className="text-[11px] text-muted-foreground">
                        Add a new case to a dataset
                      </div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setResultDatasetAction("duplicate_as_variant")}>
                    <div>
                      <div className="text-[12px] font-medium">Duplicate as a variant</div>
                      <div className="text-[11px] text-muted-foreground">
                        Branch this case without touching the original
                      </div>
                    </div>
                  </DropdownMenuItem>
                  {useRealTrace && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => {
                          setSaveTestCaseSpanId(
                            selection.type === "span" ? selection.span.span_id : undefined,
                          );
                          setSaveTestCaseOpen(true);
                        }}
                      >
                        <div>
                          <div className="text-[12px] font-medium">Save a span as a case…</div>
                          <div className="text-[11px] text-muted-foreground">
                            Capture the selected span&rsquo;s input/output
                          </div>
                        </div>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
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
              {/* Human review — shown ALONGSIDE the automated score/status (never
                  replacing it); a disagreement between the two is labelled, not hidden. */}
              <ReviewTag review={resultReview(openResult)} disagreement={isJudgeDisagreement(openResult)} />
              {/* Candidate execution vs evaluation overhead for THIS result — trace
                  derived; the judge's cost/model never fold into the candidate's. */}
              <ResultUsageSummary
                usage={resultUsage}
                durationMs={openResult.durationMs}
                taskCost={openResult.cost}
              />
            </>
          )}
          /* Baseline run's trace + a per-span matcher. Powers the viewer's Diff
             toggle: latency/token/cost deltas + I/O line diffs vs the baseline, at
             both the trace level and per span. Present (so the toggle appears) only
             once the baseline trace has loaded. */
          diffBaseline={
            baselineTrace.data
              ? {
                  trace: baselineTrace.data,
                  matchSpan: (selection) =>
                    selection.type === "span"
                      ? (baselineSpanMatch?.get(selection.span.span_id) ?? null)
                      : null,
                }
              : undefined
          }
        />
      )}

      {/* Human review of one output — scores it, never touches the dataset. */}
      <ReviewPanel
        target={
          openResult
            ? ({
                // The result id, not the object literal below (which is rebuilt on
                // every render) — ReviewPanel keys its form-reset effect on this so
                // an unrelated re-render (e.g. a background refetch) can't wipe an
                // in-progress review.
                targetKey: openResult.id,
                contextLabel: `${openResult.testCaseId} · ${run?.evaluationName} ${run?.candidateVersion}`,
                input: openResult.input,
                output: openResult.candidateOutput ?? "No output — the task errored.",
                expected: openResult.expectedOutput,
                autoScores: openResult.scores.map((s) => ({
                  name: `${s.scorerName} ${s.scorerVersion}`,
                  display: s.error ? "Scorer error" : scoreValue(s),
                  explanation: s.error ?? s.explanation ?? undefined,
                })),
                existing: toExistingReview(openResult.humanScores),
              } satisfies ReviewTarget)
            : null
        }
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onSave={(review) =>
          // A promise ReviewPanel awaits: it only toasts "Review saved" and closes
          // the drawer once this resolves, and surfaces a failure (rejecting here)
          // instead of silently discarding the review.
          new Promise<void>((resolve, reject) => {
            humanScore.mutate(
              {
                verdict: review.verdict,
                quality: review.quality ?? null,
                comment: review.comment ?? null,
                reviewer: review.reviewer,
              },
              { onSuccess: () => resolve(), onError: (e) => reject(e) },
            );
          })
        }
      />

      {/* Save a span (or the trace root) of the open result's real trace as a test case. */}
      <SaveTestCaseDrawer
        projectId={projectId}
        traceId={useRealTrace ? realTraceId : null}
        spanId={saveTestCaseSpanId}
        open={saveTestCaseOpen}
        onOpenChange={setSaveTestCaseOpen}
      />

      {/* Result → dataset: update the source case, save a new one, or duplicate as a
          variant. Publishes a new immutable dataset version; never a scoring action. */}
      {openResult && run && (
        <SaveResultToDatasetDrawer
          projectId={projectId}
          open={resultDatasetAction !== null}
          onOpenChange={(o) => {
            if (!o) setResultDatasetAction(null);
          }}
          action={resultDatasetAction ?? "update_existing_case"}
          result={{
            id: openResult.id,
            input: openResult.input,
            expectedOutput: openResult.expectedOutput,
            candidateOutput: openResult.candidateOutput,
            testCaseId: openResult.testCaseId,
          }}
          sourceDatasetId={run.datasetId}
          sourceDatasetName={run.datasetName ?? "this run's dataset"}
        />
      )}
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
  compareId,
  onCompareChange,
  compareData,
  compareLoading,
  compareByCase,
}: {
  projectId: string;
  run: RunDetail;
  results: ResultRow[];
  filter: ResultFilterId;
  onFilterChange: (filter: ResultFilterId) => void;
  onOpenResult: (id: string) => void;
  openResultId: string | null;
  compareId: string | null;
  onCompareChange: (id: string | null) => void;
  compareData: CompareRunsResponse | null;
  compareLoading: boolean;
  compareByCase: Map<string, CompareResultRow> | null;
}) {
  const router = useRouter();
  const [reproduceOpen, setReproduceOpen] = React.useState(false);
  const comparing = !!compareByCase;
  const cmp = compareData?.comparison ?? null;
  // Headline deltas vs the baseline, shown only when the comparison is usable. Main
  // score is the trustworthy backend delta; duration and cost are this run's summed
  // per-case totals minus the baseline's (the same metrics the stats show).
  const headlineComparison: HeadlineComparison | null =
    comparing && cmp && cmp.state !== "unavailable"
      ? {
          mainScoreDelta: cmp.mainScore.delta,
          elapsedDeltaMs:
            run.elapsedMs !== null && compareData?.baseline.elapsedMs != null
              ? run.elapsedMs - compareData.baseline.elapsedMs
              : null,
          costDelta:
            run.cost != null && compareData?.baseline.cost != null
              ? run.cost - compareData.baseline.cost
              : null,
        }
      : null;

  // This evaluation's other runs, to pick a comparison baseline from. `run` is always
  // loaded here (RunBody only mounts once the run-detail fetch resolves), so this never
  // fires the unfiltered, whole-project query the header RunSwitcher's own call would —
  // both share the same evaluation-scoped query key, so it's one fetch, not two.
  const siblingRuns = useEvaluationRuns(projectId, { evaluation_id: run.evaluationId, limit: 100 });

  // Only runs of the SAME evaluation AND the same dataset snapshot, still running
  // excluded — anything else is a baseline the engine (comparison.ts) would flag
  // `different_dataset_version` or `baseline_not_terminal` and mark untrustworthy.
  // Newest first, current run excluded.
  const compareOptions = React.useMemo(
    () =>
      (siblingRuns.data?.data ?? [])
        .filter(
          (s) =>
            s.id !== run.id &&
            s.datasetVersionId === run.datasetVersionId &&
            s.status !== "running",
        )
        .sort((a, b) => b.runNumber - a.runNumber)
        .map((s) => ({
          id: s.id,
          label: `#${s.runNumber} · ${s.candidateVersion} · ${s.datasetVersionLabel}`,
          score: s.mainScore,
        })),
    [siblingRuns.data, run],
  );

  return (
    <>
      <EvalPageHeader
        parent={{ label: "Evaluations", href: `/projects/${projectId}/evaluations` }}
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
        action={
          <div className="flex items-center gap-2">
            {/* Comparison is an inline action: this run is the candidate; pick another
                run of the same evaluation as the baseline. The diff appears in place. */}
            <Select
              value={compareId ?? ""}
              onValueChange={(v) => onCompareChange(v === NO_COMPARE ? null : v)}
            >
              <SelectTrigger
                // Left-aligned and content-sized so the icon and value stay adjacent.
                // The value is rendered here (not via SelectValue) as a flex row so the
                // NAME truncates while the score stays pinned — SelectValue would clamp
                // the whole string end-first and eat the score. `!flex` overrides the
                // base `[&>span]:line-clamp-1` (display:-webkit-box), which would
                // otherwise win on specificity and break the row.
                className="h-7 w-fit max-w-[240px] justify-start gap-1.5 text-[12px] [&>span]:!flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1.5"
                aria-label="Compare with"
              >
                <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {(() => {
                  const selected = compareId
                    ? compareOptions.find((o) => o.id === compareId)
                    : null;
                  if (!selected)
                    return <span className="text-foreground">Compare with…</span>;
                  return (
                    <span>
                      <span className="min-w-0 truncate">{selected.label}</span>
                      {selected.score !== null && (
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {pctFraction(selected.score)}
                        </span>
                      )}
                    </span>
                  );
                })()}
              </SelectTrigger>
              <SelectContent>
                {/* Clear option — only meaningful once a run is picked. */}
                {compareId && (
                  <SelectItem value={NO_COMPARE} className="text-[12px] text-muted-foreground">
                    None (stop comparing)
                  </SelectItem>
                )}
                {compareOptions.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                    No other runs in this evaluation
                  </div>
                ) : (
                  compareOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id} className="text-[12px]">
                      {o.label}
                      {o.score !== null && (
                        <span className="ml-1.5 tabular-nums text-muted-foreground">
                          {pctFraction(o.score)}
                        </span>
                      )}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              onClick={() => setReproduceOpen(true)}
            >
              <Database className="h-3.5 w-3.5" aria-hidden />
              Reproduce locally
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {compareLoading && (
            <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
              Computing comparison…
            </div>
          )}

          {/* Comparability is a single backend-owned discriminant (`cmp.state`). An
              `unavailable` comparison is only the banner + a way out; every other
              state keeps the counts strip, and a non-trustworthy state rides the
              banner ABOVE it so the counts are never read as an authoritative verdict. */}
          {comparing && cmp && cmp.state === "unavailable" && (
            <div className="border-b border-border px-3 py-2">
              <ComparabilityBanner
                state={cmp.state}
                reasons={cmp.reasons}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => onCompareChange(null)}
                  >
                    Clear
                  </Button>
                }
              />
            </div>
          )}

          {comparing && cmp && cmp.state !== "unavailable" && (
            <>
              {cmp.state !== "trustworthy" && (
                <div className="border-b border-border px-3 py-2">
                  <ComparabilityBanner state={cmp.state} reasons={cmp.reasons} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/30 px-3 py-2 text-[11px]">
                <span className="flex items-center gap-1.5">
                  <GitCompare className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  <span className="font-medium">
                    Comparing vs #{compareData?.baseline.runNumber} ·{" "}
                    <span className="font-mono">{compareData?.baseline.candidateVersion}</span>
                  </span>
                </span>
                <span className="text-muted-foreground">baseline → candidate (this run)</span>
                <span className="h-3 w-px bg-border" aria-hidden />
                <span className={cmp.caseCounts.regressed > 0 ? SENTIMENT_CLASS.bad : ""}>
                  {cmp.caseCounts.regressed} regressed
                </span>
                <span className={cmp.caseCounts.improved > 0 ? SENTIMENT_CLASS.good : ""}>
                  {cmp.caseCounts.improved} improved
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => onCompareChange(null)}
                >
                  Clear
                </Button>
              </div>
            </>
          )}

          <ResultsSection
            run={run}
            results={results}
            comparing={comparing}
            comparison={headlineComparison}
            compareByCase={compareByCase}
            filter={filter}
            onFilterChange={onFilterChange}
            onOpen={onOpenResult}
            openResultId={openResultId}
          />
        </div>
      </div>

      {/* Reproduce this run locally = pull the EXACT dataset version it scored (not
          the run/evaluation id, which pulls nothing). Shared pull-code drawer. */}
      <PullCodeDrawer
        title="Reproduce this run locally"
        subtitle={
          <>
            Re-run a new candidate against the exact cases{" "}
            <span className="font-medium text-foreground">
              {run.evaluationName} #{run.runNumber}
            </span>{" "}
            scored — the same dataset snapshot, so the results line up against this run.
          </>
        }
        options={[
          {
            id: "reproduce",
            label: "Reproduce this run",
            note: (
              <>
                Pins{" "}
                <span className="font-medium text-foreground">
                  {run.datasetName ?? "this dataset"}
                </span>{" "}
                at version <span className="font-mono">{run.datasetVersionLabel}</span> (snapshot{" "}
                <span className="font-mono">{run.datasetVersionId}</span>), and passes this run
                (candidate <span className="font-mono">{run.candidateVersion}</span>) as the
                baseline to compare the new run against.
              </>
            ),
            py: reproduceRunCode(run.datasetVersionId, run.evaluationName, run.id),
            ts: reproduceRunCodeTs(run.datasetVersionId, run.evaluationName, run.id),
          },
        ]}
        open={reproduceOpen}
        onOpenChange={setReproduceOpen}
      />
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
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Run #{run.runNumber}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[360px] w-72 overflow-y-auto p-1">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Run history
        </div>
        {runs.map((sibling) => (
          <button
            key={sibling.id}
            type="button"
            onClick={() => {
              onPick(sibling.id);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/50"
          >
            <Check
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                sibling.id === run.id ? "opacity-100" : "opacity-0",
              )}
              aria-hidden
            />
            <span className="font-medium">Run #{sibling.runNumber}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {sibling.candidateVersion}
            </span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {sibling.mainScore === null ? "—" : pctFraction(sibling.mainScore)}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const RESULT_COLUMN_COUNT = 8;

/** Sentinel for the "Compare with" select's no-selection option (Radix needs a value). */
const NO_COMPARE = "__none__";

/**
 * Run-level headline metrics — main score, pass rate, cost, duration — above the
 * filter bar. Sourced from `run` (never derived from `results`), so an empty or
 * fully-failing run still renders these instead of a blank strip. `null`/`undefined`
 * render "—", never a fabricated 0 — the run may simply not have reported a cost,
 * or may still be running (no `elapsedMs` yet).
 */
/** Headline deltas vs the compared baseline. Only the metrics whose baseline the
 *  compare response actually carries: the trustworthy main-score delta and the
 *  wall-clock duration delta. Pass rate and cost have no baseline in that payload,
 *  so they show absolutes even while comparing (an honest gap, not a fabricated 0). */
interface HeadlineComparison {
  mainScoreDelta: number | null;
  elapsedDeltaMs: number | null;
  costDelta: number | null;
}

/** Signed delta beside a headline stat when comparing. `goodWhenPositive` flips the
 *  sentiment: a higher score is good, a longer duration is bad. */
function HeadlineDelta({
  positive,
  goodWhenPositive,
  children,
}: {
  positive: boolean;
  goodWhenPositive: boolean;
  children: React.ReactNode;
}) {
  const good = positive === goodWhenPositive;
  return (
    <span
      className={cn(
        "ml-1.5 text-[11px] font-normal",
        good ? SENTIMENT_CLASS.good : SENTIMENT_CLASS.bad,
      )}
    >
      {positive ? "+" : "−"}
      {children}
    </span>
  );
}

function HeadlineMetrics({
  run,
  comparison,
}: {
  run: RunDetail;
  comparison: HeadlineComparison | null;
}) {
  const scoreDelta = comparison?.mainScoreDelta ?? null;
  const elapsedDelta = comparison?.elapsedDeltaMs ?? null;
  const costDelta = comparison?.costDelta ?? null;
  return (
    <div className="flex flex-wrap items-center gap-6 border-b border-border px-3 py-2">
      <HeadlineStat label={run.mainScoreName ?? "Main score"}>
        {run.mainScore === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          pctFraction(run.mainScore)
        )}
        {scoreDelta !== null && scoreDelta !== 0 && (
          <HeadlineDelta positive={scoreDelta > 0} goodWhenPositive>
            {Math.abs(scoreDelta * 100).toFixed(1)}pp
          </HeadlineDelta>
        )}
      </HeadlineStat>
      <HeadlineStat label="Pass rate">
        <PassRate counts={run} />
      </HeadlineStat>
      <HeadlineStat
        label="Cost (candidate)"
        title="Candidate task cost only — excludes evaluation (judge) cost. Open a result for the candidate-vs-evaluation split."
      >
        {run.cost === null || run.cost === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `$${run.cost.toFixed(4)}`
        )}
        {costDelta !== null && costDelta !== 0 && (
          <HeadlineDelta positive={costDelta > 0} goodWhenPositive={false}>
            {`$${Math.abs(costDelta).toFixed(4)}`}
          </HeadlineDelta>
        )}
      </HeadlineStat>
      <HeadlineStat label="Duration">
        {fmtDurationMs(run.elapsedMs)}
        {elapsedDelta !== null && elapsedDelta !== 0 && (
          <HeadlineDelta positive={elapsedDelta > 0} goodWhenPositive={false}>
            {fmtDurationMs(Math.abs(elapsedDelta))}
          </HeadlineDelta>
        )}
      </HeadlineStat>
      <HumanReviewHeadline hr={run.humanReview} />
    </div>
  );
}

/**
 * Run-level human-review summary. Sits alongside the automated headline stats and
 * never replaces them — human review is a separate, co-equal signal.
 */
function HumanReviewHeadline({ hr }: { hr: HumanReviewSummary | undefined }) {
  if (!hr || hr.dimensions.length === 0) {
    return (
      <HeadlineStat label="Human review">
        <span className="text-muted-foreground">Not started</span>
      </HeadlineStat>
    );
  }
  const total = hr.reviewedCount + hr.pendingCount;
  const judged = hr.passCount + hr.failCount;
  return (
    <>
      <HeadlineStat label="Human review">
        {hr.reviewedCount} / {total}
      </HeadlineStat>
      <HeadlineStat label="Human pass rate">
        {judged === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          pctFraction(hr.passCount / judged)
        )}
      </HeadlineStat>
      <HeadlineStat label="Disagreements">
        {hr.disagreementCount === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          <span className="text-amber-600 dark:text-amber-500">{hr.disagreementCount}</span>
        )}
      </HeadlineStat>
    </>
  );
}

function HeadlineStat({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="text-[13px] font-medium tabular-nums">{children}</div>
    </div>
  );
}

function ResultsSection({
  run,
  results,
  comparing,
  comparison,
  compareByCase,
  filter,
  onFilterChange,
  onOpen,
  openResultId,
}: {
  run: RunDetail;
  results: ResultRow[];
  comparing: boolean;
  comparison: HeadlineComparison | null;
  compareByCase: Map<string, CompareResultRow> | null;
  filter: ResultFilterId;
  onFilterChange: (filter: ResultFilterId) => void;
  onOpen: (id: string) => void;
  openResultId: string | null;
}) {
  const [keyword, setKeyword] = React.useState("");
  const [sortWorst, setSortWorst] = React.useState(false);

  // Per-result comparison vs the picked run (null when not comparing).
  const cmpFor = React.useCallback(
    (r: ResultRow) => (comparing ? (compareByCase?.get(r.testCaseId) ?? null) : null),
    [comparing, compareByCase],
  );

  const visible = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const filtered = results.filter((r) => {
      if (!RESULT_FILTER_FN[filter](r, activeComparison(r, compareByCase))) return false;
      if (!q) return true;
      return (
        r.input.toLowerCase().includes(q) ||
        (r.candidateOutput ?? "").toLowerCase().includes(q) ||
        (r.expectedOutput ?? "").toLowerCase().includes(q)
      );
    });
    if (!sortWorst) return filtered;
    // Worst main-score regression first (most-negative delta vs the picked run); unknown last.
    return [...filtered].sort((a, b) => {
      const da = cmpFor(a)?.comparison?.mainScore.delta;
      const db = cmpFor(b)?.comparison?.mainScore.delta;
      if (da == null && db == null) return 0;
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    });
  }, [results, keyword, filter, sortWorst, cmpFor, compareByCase]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Headline metrics for the run — rendered from the run itself, never from
          `results`, so they still show for an empty or fully-failing run (no
          per-case rows) rather than leaving this a blank strip above the table. */}
      <HeadlineMetrics run={run} comparison={comparison} />
      {/* No date-range control here: every result in this table belongs to one run,
          so there is no time range to narrow — a date filter would render but
          filter nothing. */}
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
        {/* This is the run's overall pass rate — it does not change with the status
            filter above, so it reads as the run's rate, not a count of the
            currently-visible rows. */}
        <PassRate counts={run} withLabel />
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
      </SearchFilterBar>

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <Th>Input</Th>
              <Th>Output</Th>
              <Th>Expected</Th>
              <Th className="w-[170px]">Main score</Th>
              {/* Change is only meaningful against a picked run; hidden otherwise. */}
              {comparing && <Th className="w-[110px] text-right">vs baseline</Th>}
              <Th className="w-[90px] text-right">Duration</Th>
              <Th className="w-[90px] text-right">Cost</Th>
              <Th className="w-[110px]">Status</Th>
            </TRHead>
          </THead>
          <TBody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={comparing ? RESULT_COLUMN_COUNT : RESULT_COLUMN_COUNT - 1}>
                  <p className="px-4 py-12 text-center text-[12px] text-muted-foreground">
                    {results.length === 0
                      ? "No per-case results reported for this run yet."
                      : "No results match this filter."}
                  </p>
                </td>
              </tr>
            ) : (
              visible.map((result) => {
                const row = cmpFor(result);
                const rowCmp = row?.comparison ?? null;
                return (
                  <TR
                    key={result.id}
                    interactive
                    selected={result.id === openResultId}
                    onClick={() => onOpen(result.id)}
                  >
                    <Td className="max-w-[260px] truncate">{result.input}</Td>
                    <Td className="max-w-[260px]">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">
                          {result.candidateOutput ?? (
                            <span className="text-muted-foreground">No output</span>
                          )}
                        </span>
                        {row?.outputChanged === true && rowCmp?.pairing === "paired" && (
                          <span
                            className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                            title="Output differs from the baseline run"
                          >
                            ≠ baseline
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td className="max-w-[220px] truncate text-muted-foreground">
                      {result.expectedOutput ?? "—"}
                    </Td>
                    <Td>
                      <MainScoreCell result={result} comparison={rowCmp} />
                    </Td>
                    {comparing && (
                      <Td className="text-right">
                        <ChangeCell change={rowCmp?.caseChange ?? null} />
                      </Td>
                    )}
                    <Td className="whitespace-nowrap text-right text-[11px] tabular-nums text-muted-foreground">
                      {fmtDurationMs(result.durationMs)}
                      {comparing && (
                        <CellDelta delta={rowCmp?.durationDeltaMs ?? null} format={fmtDurationMs} />
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right text-[11px] tabular-nums text-muted-foreground">
                      {result.cost === null ? "—" : `$${result.cost.toFixed(4)}`}
                      {comparing && result.cost !== null && row?.baselineCost != null && (
                        <CellDelta
                          delta={result.cost - row.baselineCost}
                          format={(n) => `$${n.toFixed(4)}`}
                        />
                      )}
                    </Td>
                    <Td>
                      <EvalResultBadge status={result.status} />
                    </Td>
                  </TR>
                );
              })
            )}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Per-result candidate main score, and — when comparing against a picked run — its
 * baseline counterpart + delta (the backend engine derives the per-case baseline value,
 * so we show a real magnitude). Missing values render "—", never a fabricated 0.
 */
function MainScoreCell({
  result,
  comparison,
}: {
  result: ResultRow;
  comparison: ResultRowComparison | null;
}) {
  const cand = comparison?.mainScore.candidate ?? result.mainScore;
  if (cand === null || cand === undefined) return <span className="text-muted-foreground">—</span>;
  const base = comparison?.mainScore.baseline ?? null;
  const delta = comparison?.mainScore.delta ?? null;
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

/** Per-result case verdict (derived from the main scorer). */
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
