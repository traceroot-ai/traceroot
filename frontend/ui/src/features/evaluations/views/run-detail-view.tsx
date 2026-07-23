"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Database,
  GitCompare,
  Info,
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
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  EvalPageHeader,
  EvalResultBadge,
  ReviewPanel,
  Timestamp,
  useSeedTraceIO,
  type ReviewTarget,
} from "@/features/offline-eval/components";
import { useQueries } from "@tanstack/react-query";
import { TraceViewerPanel } from "@/features/traces/components";
import { useTrace } from "@/features/traces/hooks";
import { getTrace } from "@/lib/api";
import { useSession as useAuthSession } from "@/lib/auth-client";
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
import { useEvaluationRun, useEvaluationRuns, useCreateHumanScore, useCompareRuns } from "../hooks";
import { PullCodeDrawer } from "../components/pull-code-drawer";
import { PassRate } from "../components/pass-rate";
import { SaveTestCaseDrawer } from "../components/trace-integration";
import { reproduceRunCode, reproduceRunCodeTs } from "@/features/offline-eval/utils";
import { attributeTraceUsage, type TraceUsage, type UsageSpan } from "@/lib/eval/trace-usage";
import { matchSpans } from "@/lib/eval/span-match";
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
} from "../types";

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
  | "not_scored";

const RESULT_FILTERS: Array<{ id: ResultFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "regressions", label: "Regressions" },
  { id: "improvements", label: "Improvements" },
  { id: "failed", label: "Did not pass" },
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
  // "Save as test case" drawer (only for real ingested traces): which span it targets.
  const [saveTestCaseOpen, setSaveTestCaseOpen] = React.useState(false);
  const [saveTestCaseSpanId, setSaveTestCaseSpanId] = React.useState<string | undefined>(undefined);
  // "Compare with" — another run of the SAME evaluation, chosen inline. The current run
  // is the candidate; the picked run is the baseline. Comparison is computed on demand
  // by the backend engine (the SDK no longer declares baselines).
  const [compareId, setCompareId] = React.useState<string | null>(null);

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

  // Other runs of this evaluation, to pick a comparison baseline from (never an
  // arbitrary run from another evaluation). Newest first, current run excluded.
  const compareOptions = React.useMemo(
    () =>
      run
        ? (siblingRuns.data?.data ?? [])
            .filter((s) => s.id !== run.id)
            .sort((a, b) => b.runNumber - a.runNumber)
            .map((s) => ({
              id: s.id,
              label: `#${s.runNumber} · ${s.candidateVersion}`,
              score: s.mainScore,
            }))
        : [],
    [siblingRuns.data, run],
  );

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

  // The baseline case's trace (from the picked compare run), fetched so the trace
  // viewer's Diff toggle can diff each span (I/O, metadata, latency/token/cost) against
  // its baseline counterpart. Span ids differ across runs, so we match structurally
  // (kind + name + sibling index) once the baseline trace is loaded.
  const baselineTraceId = comparing ? (openCompareRow?.baselineTraceId ?? null) : null;
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
            compareId={compareId}
            onCompareChange={setCompareId}
            compareOptions={compareOptions}
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
                Review output
              </Button>
              <Link
                href={`/projects/${projectId}/datasets/${run.datasetId}?case=${openResult.testCaseId}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Database className="h-3.5 w-3.5" aria-hidden />
                View source test case
              </Link>
              {useRealTrace && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[12px]"
                  onClick={() => {
                    setSaveTestCaseSpanId(
                      selection.type === "span" ? selection.span.span_id : undefined,
                    );
                    setSaveTestCaseOpen(true);
                  }}
                >
                  Save as test case
                </Button>
              )}
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
  compareOptions,
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
  compareOptions: Array<{ id: string; label: string; score: number | null }>;
  compareData: CompareRunsResponse | null;
  compareLoading: boolean;
  compareByCase: Map<string, CompareResultRow> | null;
}) {
  const router = useRouter();
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [reproduceOpen, setReproduceOpen] = React.useState(false);
  const comparing = !!compareByCase;
  // Trust note reflects the PICKED comparison (not a stored baseline).
  const cmp = compareData?.comparison ?? null;
  const incompatibleComparison = comparing && !!cmp && cmp.available && !cmp.trustworthy;
  const trustNote = cmp ? comparisonReasonText(cmp.reasons, run.datasetVersionLabel) : "";

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
        action={
          <div className="flex items-center gap-2">
            {/* Comparison is an inline action: this run is the candidate; pick another
                run of the same evaluation as the baseline. The diff appears in place. */}
            <Select
              value={compareId ?? ""}
              onValueChange={(v) => onCompareChange(v === NO_COMPARE ? null : v)}
            >
              <SelectTrigger
                className="h-7 w-[200px] gap-1.5 text-[12px]"
                aria-label="Compare with"
              >
                <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <SelectValue placeholder="Compare with…" />
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
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              onClick={() => setDetailsOpen(true)}
            >
              <Info className="h-3.5 w-3.5" aria-hidden />
              Run details
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-3 p-4">
          {compareLoading && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              Computing comparison…
            </div>
          )}

          {comparing && cmp && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px]">
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
          )}

          {incompatibleComparison && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Comparison not fully trustworthy.</span> {trustNote}{" "}
                The change is shown for context but should not be read as a clean verdict.
              </span>
            </div>
          )}

          <ResultsSection
            run={run}
            results={results}
            comparing={comparing}
            compareByCase={compareByCase}
            filter={filter}
            onFilterChange={onFilterChange}
            onOpen={onOpenResult}
            openResultId={openResultId}
          />

          {/* Errors fold below the results; run details open in a side panel. */}
          {run.errorCount > 0 && (
            <ExpandableSection title={`Errors (${run.errorCount})`} defaultOpen={false}>
              <ErrorsBody run={run} results={results} onOpen={onOpenResult} />
            </ExpandableSection>
          )}
        </div>
      </div>

      <RunDetailsDrawer
        run={run}
        projectId={projectId}
        results={results}
        compareData={compareData}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />

      {/* Reproduce this run locally = pull the EXACT dataset version it scored (not
          the run/evaluation id, which pulls nothing). Shared pull-code drawer. */}
      <PullCodeDrawer
        title="Reproduce this run locally"
        subtitle={
          <>
            Pulls the exact cases{" "}
            <span className="font-medium text-foreground">
              {run.evaluationName} #{run.runNumber}
            </span>{" "}
            scored, so a new candidate is measured on the same data and is comparable to this run.
          </>
        }
        options={[
          {
            id: "reproduce",
            label: "Reproduce this run",
            note: (
              <>
                Pins dataset version <span className="font-mono">{run.datasetVersionId}</span>. The
                run id (<span className="font-mono">{run.id}</span>) is only used as the{" "}
                <span className="font-mono">baseline</span> to compare against — it isn&apos;t
                pullable.
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

/** Run details (identity, dataset, scorers, provenance) as a right-side slide-out,
 *  opened from the header — matching the starter-code / pull-code drawers. */
function RunDetailsDrawer({
  run,
  projectId,
  results,
  compareData,
  open,
  onOpenChange,
}: {
  run: RunDetail;
  projectId: string;
  results: ResultRow[];
  compareData: CompareRunsResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[560px] max-w-[96vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold">Run details</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {run.evaluationName} #{run.runNumber} · {run.candidateVersion}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="mt-0.5 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-[12px]">
        {/* Mounted only while the drawer is open, so the per-case trace fetches for
            the token/cost aggregate happen lazily, not on every run-detail load. */}
        <RunMetricsDiff
          run={run}
          projectId={projectId}
          results={results}
          compareData={compareData}
        />
        <RunDetailsBody run={run} projectId={projectId} />
      </div>
    </div>
  );
}

/**
 * Run-level metrics. Duration is derived server-side (paired case-duration mean).
 * Tokens/cost are aggregated across the run's case traces — fetched lazily here (only
 * while the drawer is open) and summed; while any trace is still loading it shows a
 * "computing" note, and traces without provider usage simply contribute nothing.
 *
 * The baseline column is driven by the page's "Compare with" selection (comparison is
 * frontend-owned now that the SDK no longer sends a stored baseline): with a run picked,
 * each metric shows its ± delta vs that run; with none picked, only the candidate value.
 */
function RunMetricsDiff({
  run,
  projectId,
  results,
  compareData,
}: {
  run: RunDetail;
  projectId: string;
  results: ResultRow[];
  compareData: CompareRunsResponse | null;
}) {
  const { data: authSession } = useAuthSession();
  const user = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;

  const candidateIds = React.useMemo(
    () => [...new Set(results.map((r) => r.traceId).filter((x): x is string => !!x))],
    [results],
  );
  // Baseline traces come from the picked compare run (per-case baselineTraceId), not a
  // stored per-result baseline (which the SDK is dropping).
  const baselineIds = React.useMemo(
    () =>
      compareData
        ? [
            ...new Set(
              compareData.results.map((r) => r.baselineTraceId).filter((x): x is string => !!x),
            ),
          ]
        : [],
    [compareData],
  );
  const allIds = React.useMemo(
    () => [...new Set([...candidateIds, ...baselineIds])],
    [candidateIds, baselineIds],
  );

  // Share useTrace's cache key so any already-opened trace is reused, not refetched.
  const queries = useQueries({
    queries: allIds.map((id) => ({
      queryKey: ["trace", projectId, id],
      queryFn: () => getTrace(projectId, id, "", user),
      enabled: !!user,
    })),
  });

  const usageById = new Map<string, TraceUsage>();
  let loading = false;
  allIds.forEach((id, i) => {
    const q = queries[i];
    if (q.isLoading || q.isFetching) loading = true;
    usageById.set(id, attributeTraceUsage(q.data?.spans as UsageSpan[] | undefined));
  });

  const sum = (ids: string[]) => {
    let tokens = 0;
    let cost = 0;
    let any = false;
    for (const id of ids) {
      const u = usageById.get(id);
      if (u && u.state === "present") {
        tokens += u.combined.totalTokens;
        cost += u.combined.cost;
        any = true;
      }
    }
    return any ? { tokens, cost } : null;
  };
  const cand = sum(candidateIds);
  const base = sum(baselineIds);
  // Duration deltas come from the picked compare run when comparing; otherwise the
  // candidate's own mean with no baseline.
  const dur = compareData?.comparison.duration ?? run.comparison.duration;

  const fmtTok = (n: number) => `${Math.round(n).toLocaleString()}`;
  const fmtCost = (n: number) => (n > 0 ? `$${n.toFixed(4)}` : "$0");
  const fmtMs = (n: number) => (n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`);

  return (
    <div className="mb-3 overflow-hidden rounded border border-border">
      <div className="border-b border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
        {compareData ? (
          <>
            Metrics vs #{compareData.baseline.runNumber}{" "}
            <span className="text-foreground">({compareData.baseline.candidateVersion})</span>
          </>
        ) : (
          <>
            Run metrics <span>— pick a run in “Compare with” for deltas</span>
          </>
        )}
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[10px] text-muted-foreground">
            <th className="py-1 pl-2.5 text-left font-normal"></th>
            <th className="py-1 pr-2.5 text-right font-normal">Candidate</th>
          </tr>
        </thead>
        <tbody className="[&_td:first-child]:pl-2.5 [&_td:last-child]:pr-2.5">
          <MetricRow
            label="Avg case duration"
            candidate={dur.candidateMeanMs}
            baseline={dur.baselineMeanMs}
            format={fmtMs}
          />
          <MetricRow
            label="Total tokens"
            candidate={cand ? cand.tokens : null}
            baseline={base ? base.tokens : null}
            format={fmtTok}
          />
          <MetricRow
            label="Total cost"
            candidate={cand ? cand.cost : null}
            baseline={base ? base.cost : null}
            format={fmtCost}
          />
        </tbody>
      </table>
      {loading && (
        <p className="border-t border-border px-2.5 py-1 text-[10px] text-muted-foreground">
          Summing token/cost across {allIds.length} case traces…
        </p>
      )}
    </div>
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

const RESULT_COLUMN_COUNT = 6;

/** Sentinel for the "Compare with" select's no-selection option (Radix needs a value). */
const NO_COMPARE = "__none__";

function ResultsSection({
  run,
  results,
  comparing,
  compareByCase,
  filter,
  onFilterChange,
  onOpen,
  openResultId,
}: {
  run: RunDetail;
  results: ResultRow[];
  comparing: boolean;
  compareByCase: Map<string, CompareResultRow> | null;
  filter: ResultFilterId;
  onFilterChange: (filter: ResultFilterId) => void;
  onOpen: (id: string) => void;
  openResultId: string | null;
}) {
  const [keyword, setKeyword] = React.useState("");
  const [sortWorst, setSortWorst] = React.useState(false);
  const [dateFilter, setDateFilter] = React.useState<DateFilterOption>(
    DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0],
  );
  const [customStart, setCustomStart] = React.useState<Date | null>(null);
  const [customEnd, setCustomEnd] = React.useState<Date | null>(null);

  // Per-result comparison vs the picked run (null when not comparing).
  const cmpFor = React.useCallback(
    (r: ResultRow) => (comparing ? (compareByCase?.get(r.testCaseId) ?? null) : null),
    [comparing, compareByCase],
  );

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
    // Worst main-score regression first (most-negative delta vs the picked run); unknown last.
    return [...filtered].sort((a, b) => {
      const da = cmpFor(a)?.comparison?.mainScore.delta;
      const db = cmpFor(b)?.comparison?.mainScore.delta;
      if (da == null && db == null) return 0;
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    });
  }, [results, keyword, filter, sortWorst, cmpFor]);

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

      <Table>
        <THead>
          <TRHead>
            <Th>Input</Th>
            <Th>Output</Th>
            <Th>Expected</Th>
            <Th className="w-[170px]">Main score</Th>
            {/* Change is only meaningful against a picked run; hidden otherwise. */}
            {comparing && <Th className="w-[110px] text-right">vs baseline</Th>}
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
                  <Td className="max-w-[260px] truncate" title={result.input}>
                    {result.input}
                  </Td>
                  <Td className="max-w-[260px]">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate" title={result.candidateOutput ?? undefined}>
                        {result.candidateOutput ?? (
                          <span className="text-muted-foreground">No output</span>
                        )}
                      </span>
                      {row?.outputChanged === true && (
                        <span
                          className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                          title="Output differs from the baseline run"
                        >
                          ≠ baseline
                        </span>
                      )}
                    </div>
                  </Td>
                  <Td
                    className="max-w-[220px] truncate text-muted-foreground"
                    title={result.expectedOutput ?? undefined}
                  >
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

/** One metric row: candidate value with its ± delta beside it (lower is better). */
function MetricRow({
  label,
  candidate,
  baseline,
  format,
  lowerIsBetter = true,
}: {
  label: string;
  candidate: number | null;
  baseline: number | null;
  format: (n: number) => string;
  lowerIsBetter?: boolean;
}) {
  const delta = candidate !== null && baseline !== null ? candidate - baseline : null;
  return (
    <tr>
      <td className="py-1 pr-2 text-muted-foreground">{label}</td>
      {/* Candidate value with its ± delta vs baseline beside it (lower is better). */}
      <td className="py-1 text-right tabular-nums">
        {candidate === null ? (
          "—"
        ) : (
          <>
            {format(candidate)}
            {delta !== null &&
              (delta === 0 ? (
                <span className="ml-1.5 text-muted-foreground">±0</span>
              ) : (
                <span
                  className={cn(
                    "ml-1.5",
                    SENTIMENT_CLASS[changeSentiment(lowerIsBetter ? -delta : delta)],
                  )}
                >
                  {delta > 0 ? "+" : "−"}
                  {format(Math.abs(delta))}
                </span>
              ))}
          </>
        )}
      </td>
    </tr>
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
