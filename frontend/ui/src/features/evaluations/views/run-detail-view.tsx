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
  pct,
  SENTIMENT_CLASS,
  signed,
  truncate,
} from "@/features/offline-eval/utils";
import {
  useEvaluationRun,
  useEvaluationRuns,
  useCreateHumanScore,
  useUpdateTestCase,
} from "../hooks";
import { RunStatusBadge } from "./evaluations-view";
import type { ResultRow, RunDetail, ScoreRow } from "../types";

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

type ResultFilterId = "all" | "regressions" | "failed" | "errors" | "not_scored";

const RESULT_FILTERS: Array<{ id: ResultFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "regressions", label: "Regressions" },
  { id: "failed", label: "Failed" },
  { id: "errors", label: "Errors" },
  { id: "not_scored", label: "Not scored" },
];

const RESULT_FILTER_FN: Record<ResultFilterId, (r: ResultRow) => boolean> = {
  all: () => true,
  regressions: (r) => r.change === "regressed",
  failed: (r) => r.status === "failed",
  errors: (r) => r.status === "errored" || r.scores.some((s) => s.error),
  not_scored: (r) => r.status === "not_scored",
};

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

  const openResult = openResultId ? (results.find((r) => r.id === openResultId) ?? null) : null;

  // Prefer the result's REAL ingested trace. Probe it — this shares TraceViewerPanel's
  // ["trace", projectId, traceId] cache key, so opening the real panel does not refetch.
  // A result trace id means telemetry was emitted: show the real trace when it's
  // available, and a pending state (retry) while it is still ingesting. When no trace
  // id was emitted (fully-local run), fall back to a clearly-labeled reconstructed trace.
  const realTraceId = openResult?.traceId ?? null;
  const realTrace = useTrace(projectId, realTraceId ?? "", !!realTraceId);
  const hasRealTrace = !!realTraceId && !!realTrace.data;
  const tracePending = !!realTraceId && !realTrace.data; // loading or still ingesting

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

  const panelTraceId = hasRealTrace ? realTraceId : fallbackTrace?.trace_id;
  const panelOverride = hasRealTrace ? undefined : fallbackTrace;

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
      <ProjectBreadcrumb projectId={projectId} current="Evaluations" />
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
          key={panelTraceId}
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
              {!hasRealTrace && (
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
  const regressed = results.filter((r) => r.change === "regressed");
  const incompatibleBaseline = run.baselineRunId !== null && !run.baselineComparable;

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
                <span className="font-medium">Not directly comparable.</span> The selected baseline
                measured a different dataset snapshot than this run (
                <span className="font-mono">{run.datasetVersionLabel}</span>). The two runs covered
                different test cases, so a single delta would be misleading. Pick a baseline on the
                same snapshot to compare.
              </span>
            </div>
          )}

          {/* Verdict first, as a one-line strip — then results are the hero. */}
          <VerdictStrip
            run={run}
            regressionCount={regressed.length}
            hasBaseline={hasBaseline}
            onFilter={onFilterChange}
          />

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
              {sibling.mainScore === null ? "—" : pct(sibling.mainScore)}
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
  regressionCount,
  hasBaseline,
  onFilter,
}: {
  run: RunDetail;
  regressionCount: number;
  hasBaseline: boolean;
  onFilter: (filter: ResultFilterId) => void;
}) {
  const unscored = run.caseCount - run.scoredCount;
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <RunStatusBadge status={run.status} />
        <Metric
          label={run.mainScoreName ?? "Main score"}
          value={run.mainScore === null ? "—" : pct(run.mainScore)}
          strong
        />
        <Metric
          label="Change"
          value={
            run.changeFromBaseline === null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <span className={SENTIMENT_CLASS[changeSentiment(run.changeFromBaseline)]}>
                {signed(run.changeFromBaseline)} pp
              </span>
            )
          }
          hint={hasBaseline ? undefined : "No baseline"}
        />
        <FilterStat
          label="Regressions"
          count={regressionCount}
          onClick={() => onFilter("regressions")}
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

/** A count that filters the results table when non-zero. */
function FilterStat({
  label,
  count,
  onClick,
}: {
  label: string;
  count: number;
  onClick: () => void;
}) {
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
  const [dateFilter, setDateFilter] = React.useState<DateFilterOption>(
    DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0],
  );
  const [customStart, setCustomStart] = React.useState<Date | null>(null);
  const [customEnd, setCustomEnd] = React.useState<Date | null>(null);

  const visible = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return results.filter((r) => {
      if (!RESULT_FILTER_FN[filter](r)) return false;
      if (!q) return true;
      return (
        r.input.toLowerCase().includes(q) ||
        (r.candidateOutput ?? "").toLowerCase().includes(q) ||
        (r.expectedOutput ?? "").toLowerCase().includes(q)
      );
    });
  }, [results, keyword, filter]);

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
            <Th className="w-[150px]">Scores</Th>
            <Th className="w-[100px] text-right">Change</Th>
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
                  <ScoreCell result={result} />
                </Td>
                <Td className="text-right">
                  <ChangeCell change={hasBaseline ? result.change : null} />
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
 * Per-result change direction. The prototype showed "+N pp" per case; the server
 * reports only the direction (improved / regressed / unchanged) per result — no
 * per-case baseline score to subtract — so we render the direction faithfully as
 * a coloured arrow rather than a fabricated magnitude.
 */
function ChangeCell({ change }: { change: ResultRow["change"] }) {
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
  return <span className="text-muted-foreground">—</span>;
}

/** Per-scorer values, with a failed scorer shown as an error rather than a 0. */
function ScoreCell({ result }: { result: ResultRow }) {
  if (result.scores.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {result.scores.map((s) => (
        <span key={s.id} className="flex items-center gap-1.5 text-[11px]">
          <span className="truncate text-muted-foreground">{s.scorerName}</span>
          <span className={cn("tabular-nums", s.error && "text-amber-600 dark:text-amber-400")}>
            {scoreValue(s)}
          </span>
        </span>
      ))}
    </span>
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
      </dl>
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
  onReview,
  onSaveExpected,
}: {
  projectId: string;
  run: RunDetail;
  result: ResultRow;
  onReview: () => void;
  onSaveExpected: (value: string) => void;
}) {
  const expectedValue = result.expectedOutput ?? "";
  const [expected, setExpected] = React.useState(expectedValue);
  React.useEffect(() => setExpected(expectedValue), [expectedValue, result.id]);
  const expectedDirty = expected.trim() !== expectedValue.trim();

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
          autoDetectKind
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

      {result.scores.length > 0 && (
        <ul className="mt-2 divide-y divide-border rounded border border-border">
          {result.scores.map((s) => (
            <li key={s.id} className="px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {s.scorerName}
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {s.scorerVersion}
                  </span>
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
      )}

      {result.humanScores.length > 0 && (
        <div className="mt-2 rounded border border-border bg-muted/20 px-2.5 py-1.5 text-[11px]">
          <span className="text-muted-foreground">Human review: </span>
          {result.humanScores.map((h, i) => (
            <span key={h.id}>
              {i > 0 ? "; " : ""}
              <span className="font-medium capitalize">{h.verdict}</span>
              {h.comment ? ` — ${h.comment}` : ""}
            </span>
          ))}
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
        <span className="ml-auto text-[11px] text-muted-foreground">
          {result.durationMs !== null ? `${(result.durationMs / 1000).toFixed(1)}s` : "—"}
          {result.cost !== null ? ` · $${result.cost.toFixed(4)}` : ""}
        </span>
      </div>
    </div>
  );
}
