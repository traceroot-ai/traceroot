"use client";

import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import { ArrowLeftRight, ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { EmptyState, Timestamp } from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { changeSentiment, pctFraction, SENTIMENT_CLASS } from "@/features/offline-eval/utils";
import { cn } from "@/lib/utils";
import { getTrace } from "@/lib/api";
import { useSession as useAuthSession } from "@/lib/auth-client";
import { TraceViewerPanel } from "@/features/traces/components";
import { attributeTraceUsage, type TraceUsage, type UsageSpan } from "@/lib/eval/trace-usage";
import { useCompareRuns, useEvaluationRuns, useEvaluations } from "../hooks";
import type {
  CompareRunSummary,
  RunComparison,
  Classification,
  CompareResultRow,
  ScorerCellComparison,
} from "../types";
import { RunStatusBadge } from "./evaluations-view";
import { CompareCaseDrawer } from "./compare-case-drawer";
import { ComparabilityBanner } from "@/features/evaluations/components/comparability-banner";
import {
  deriveVerdict,
  VERDICT_META,
  CASE_FILTERS,
  CASE_SORTS,
  matchesFilter,
  filterCounts,
  sortCases,
  caseStatus,
  type CaseFilterId,
  type CaseSortId,
  type CaseStatus,
} from "../compare-derive";

// ── Small formatters ──────────────────────────────────────────────────────
const fmtScore = (v: number | null) => (v === null ? "—" : pctFraction(v));
const fmtMs = (n: number | null) =>
  n === null ? "Unknown" : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
const fmtCost = (n: number | null) => (n === null ? "Unknown" : `$${n.toFixed(4)}`);
const truncate = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

const VERDICT_TONE: Record<"good" | "bad" | "warn" | "neutral", string> = {
  good: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  bad: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  neutral: "border-border bg-muted/30 text-foreground",
};

const CHANGE_LABEL: Record<Classification, { label: string; className: string }> = {
  improved: { label: "Improved", className: SENTIMENT_CLASS.good },
  regressed: { label: "Regressed", className: SENTIMENT_CLASS.bad },
  unchanged: { label: "Unchanged", className: "text-muted-foreground" },
  changed: { label: "Changed", className: "text-foreground" },
  unpaired: { label: "Unpaired", className: "text-muted-foreground" },
  not_comparable: { label: "Not comparable", className: "text-amber-600 dark:text-amber-400" },
};

const STATUS_LABEL: Record<CaseStatus, { label: string; className: string }> = {
  ...CHANGE_LABEL,
  task_error: { label: "Task error", className: "text-red-600 dark:text-red-400" },
  scorer_error: { label: "Scorer error", className: "text-amber-600 dark:text-amber-400" },
  pending: { label: "Pending", className: "text-muted-foreground" },
};

// ── Layer 1: run identity (Baseline → Candidate) ──────────────────────────

function RunChooser({
  projectId,
  label,
  seedEvaluationId,
  runId,
  otherRunId,
  onPick,
}: {
  projectId: string;
  label: string;
  seedEvaluationId: string | null;
  runId: string | null;
  otherRunId: string | null;
  onPick: (runId: string) => void;
}) {
  const { data: evalData } = useEvaluations(projectId);
  const evaluations = React.useMemo(() => evalData?.data ?? [], [evalData]);
  const [evalId, setEvalId] = React.useState<string>(seedEvaluationId ?? "");
  React.useEffect(() => {
    if (seedEvaluationId) setEvalId(seedEvaluationId);
  }, [seedEvaluationId]);
  const { data: runsData } = useEvaluationRuns(
    projectId,
    evalId ? { evaluation_id: evalId } : undefined,
  );
  const runs = React.useMemo(() => runsData?.data ?? [], [runsData]);
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Select value={evalId} onValueChange={setEvalId}>
        <SelectTrigger className="h-7 w-[160px] text-[12px]">
          <SelectValue placeholder="Evaluation" />
        </SelectTrigger>
        <SelectContent>
          {evaluations.map((e) => (
            <SelectItem key={e.id} value={e.id} className="text-[12px]">
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={runId ?? ""} onValueChange={onPick}>
        <SelectTrigger className="h-7 w-[190px] text-[12px]">
          <SelectValue placeholder="Run" />
        </SelectTrigger>
        <SelectContent>
          {runs.map((r) => (
            <SelectItem
              key={r.id}
              value={r.id}
              className="text-[12px]"
              disabled={r.id === otherRunId}
            >
              Run #{r.runNumber} · {r.candidateVersion}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function RunHeaderCard({
  run,
  role,
  crossEval,
}: {
  run: CompareRunSummary;
  role: "Baseline" | "Candidate";
  crossEval: boolean;
}) {
  return (
    <div className="min-w-0 flex-1 rounded border border-border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{role}</span>
        <RunStatusBadge status={run.status} />
      </div>
      <div className="mt-1 text-[12px] font-medium">{run.evaluationName}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-[13px] font-semibold">Run #{run.runNumber}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {run.candidateVersion}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {run.datasetVersionLabel} · <Timestamp iso={run.startedAt} />
      </div>
      {crossEval && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">{run.evaluationName}</div>
      )}
    </div>
  );
}

// ── Layer 3: decision metrics ─────────────────────────────────────────────

type MetricState = "present" | "unknown" | "pending";

function MetricCard({
  label,
  baseline,
  candidate,
  delta,
  format,
  lowerIsBetter = false,
  state = "present",
  sub,
}: {
  label: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  format: (n: number) => string;
  lowerIsBetter?: boolean;
  state?: MetricState;
  sub?: string;
}) {
  const stateNote = state === "pending" ? "Pending" : state === "unknown" ? "Unknown" : null;
  return (
    <div className="rounded border border-border px-2.5 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {stateNote ? (
        <div className="mt-0.5 text-[13px] text-muted-foreground">{stateNote}</div>
      ) : (
        <>
          <div className="mt-0.5 flex items-baseline gap-1.5 tabular-nums">
            <span className="text-muted-foreground">
              {baseline === null ? "—" : format(baseline)}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden />
            <span className="text-[15px] font-medium">
              {candidate === null ? "—" : format(candidate)}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] tabular-nums">
            {delta === null || delta === 0 ? (
              <span className="text-muted-foreground">{delta === 0 ? "±0" : (sub ?? "—")}</span>
            ) : (
              <span className={SENTIMENT_CLASS[changeSentiment(lowerIsBetter ? -delta : delta)]}>
                {delta > 0 ? "+" : "−"}
                {format(Math.abs(delta))}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Count card (regressed/improved cases, errors) — a plain baseline→candidate/Δ tile. */
function CountCard({
  label,
  baseline,
  candidate,
  badTone = false,
}: {
  label: string;
  baseline: number;
  candidate: number;
  badTone?: boolean;
}) {
  const delta = candidate - baseline;
  return (
    <div className="rounded border border-border px-2.5 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5 tabular-nums">
        <span className="text-muted-foreground">{baseline}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden />
        <span
          className={cn("text-[15px] font-medium", badTone && candidate > 0 && SENTIMENT_CLASS.bad)}
        >
          {candidate}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
        {delta === 0 ? "±0" : delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
      </div>
    </div>
  );
}

/** Sums trace-derived tokens across cases (candidate/baseline), with pending/unknown. */
function useTokenTotals(projectId: string, rows: CompareResultRow[]) {
  const { data: authSession } = useAuthSession();
  const user = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  const ids = React.useMemo(
    () => [
      ...new Set(
        rows
          .flatMap((r) => [r.candidateTraceId, r.baselineTraceId])
          .filter((x): x is string => !!x),
      ),
    ],
    [rows],
  );
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["trace", projectId, id],
      queryFn: () => getTrace(projectId, id, "", user),
      enabled: !!user,
    })),
  });
  const usageById = new Map<string, TraceUsage>();
  let loading = false;
  ids.forEach((id, i) => {
    const q = queries[i];
    if (q.isLoading || q.isFetching) loading = true;
    usageById.set(id, attributeTraceUsage(q.data?.spans as UsageSpan[] | undefined));
  });
  const sum = (getId: (r: CompareResultRow) => string | null) => {
    let total = 0;
    let any = false;
    for (const r of rows) {
      const id = getId(r);
      const u = id ? usageById.get(id) : undefined;
      if (u && u.state === "present") {
        total += u.combined.totalTokens;
        any = true;
      }
    }
    return any ? total : null;
  };
  const candidate = sum((r) => r.candidateTraceId);
  const baseline = sum((r) => r.baselineTraceId);
  const state: MetricState =
    ids.length === 0
      ? "unknown"
      : loading
        ? "pending"
        : candidate === null && baseline === null
          ? "unknown"
          : "present";
  return { candidate, baseline, state };
}

function DecisionMetrics({
  projectId,
  comparison,
  candidate,
  baseline,
  rows,
}: {
  projectId: string;
  comparison: RunComparison;
  candidate: CompareRunSummary;
  baseline: CompareRunSummary;
  rows: CompareResultRow[];
}) {
  const tokens = useTokenTotals(projectId, rows);
  const costCand = rows.reduce<number | null>(
    (acc, r) => (r.candidateCost === null ? acc : (acc ?? 0) + r.candidateCost),
    null,
  );
  const costBase = rows.reduce<number | null>(
    (acc, r) => (r.baselineCost === null ? acc : (acc ?? 0) + r.baselineCost),
    null,
  );
  const costDelta = costCand !== null && costBase !== null ? costCand - costBase : null;
  const dur = comparison.duration;
  const candErrors = candidate.taskErrorCount + candidate.scorerErrorCount;
  const baseErrors = baseline.taskErrorCount + baseline.scorerErrorCount;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      <MetricCard
        label={comparison.scorers[0] ? "Main score" : "Main score"}
        baseline={comparison.mainScore.baseline}
        candidate={comparison.mainScore.candidate}
        delta={comparison.mainScore.delta}
        format={(n) => pctFraction(n)}
      />
      <CountCard
        label="Regressed test cases"
        baseline={0}
        candidate={comparison.caseCounts.regressed}
        badTone
      />
      <CountCard
        label="Improved test cases"
        baseline={0}
        candidate={comparison.caseCounts.improved}
      />
      <CountCard label="Errors" baseline={baseErrors} candidate={candErrors} badTone />
      <MetricCard
        label="Avg case duration"
        baseline={dur.baselineMeanMs}
        candidate={dur.candidateMeanMs}
        delta={dur.deltaMs}
        format={fmtMs}
        lowerIsBetter
        state={dur.pairedCount === 0 ? "unknown" : "present"}
      />
      <MetricCard
        label="Total cost"
        baseline={costBase}
        candidate={costCand}
        delta={costDelta}
        format={(n) => `$${n.toFixed(4)}`}
        lowerIsBetter
        state={costCand === null && costBase === null ? "unknown" : "present"}
      />
      <MetricCard
        label="Total tokens"
        baseline={tokens.baseline}
        candidate={tokens.candidate}
        delta={
          tokens.candidate !== null && tokens.baseline !== null
            ? tokens.candidate - tokens.baseline
            : null
        }
        format={(n) => Math.round(n).toLocaleString("en-US")}
        lowerIsBetter
        state={tokens.state}
      />
    </div>
  );
}

// ── Layer 3b: per-scorer summary ──────────────────────────────────────────

function ScorerSummary({ comparison }: { comparison: RunComparison }) {
  const [open, setOpen] = React.useState(true);
  const scorers = comparison.scorers;
  if (scorers.length === 0) return null;
  // Per-scorer improved/regressed cell counts from the cell tally isn't per-scorer in
  // RunComparison; derive from the aggregate's transitions/means only. Show means +
  // paired; categorical shows changed/unchanged.
  return (
    <div className="overflow-hidden rounded border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 border-b border-border bg-muted/40 px-2.5 py-1.5 text-left text-[12px] font-medium hover:bg-muted"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Scorers
      </button>
      {open && (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] text-muted-foreground">
              <th className="py-1 pl-2.5 text-left font-normal">Scorer</th>
              <th className="py-1 text-right font-normal">Baseline</th>
              <th className="py-1 text-right font-normal">Candidate</th>
              <th className="py-1 text-right font-normal">Δ</th>
              <th className="py-1 pr-2.5 text-right font-normal">Paired</th>
            </tr>
          </thead>
          <tbody className="[&_td:first-child]:pl-2.5 [&_td:last-child]:pr-2.5">
            {scorers.map((s) => {
              const better = s.direction !== "lower_is_better";
              const numeric = s.valueType !== "categorical";
              return (
                <tr key={`${s.name}@${s.version}`}>
                  <td className="py-1">
                    <span className="font-medium">{s.name}</span>{" "}
                    <span className="text-[10px] text-muted-foreground">{s.version}</span>
                  </td>
                  {numeric ? (
                    <>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">
                        {s.baselineMean === null ? "—" : pctFraction(s.baselineMean)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {s.candidateMean === null ? "—" : pctFraction(s.candidateMean)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {s.delta === null || s.delta === 0 ? (
                          <span className="text-muted-foreground">
                            {s.delta === 0 ? "±0" : "—"}
                          </span>
                        ) : (
                          <span
                            className={
                              SENTIMENT_CLASS[changeSentiment(better ? s.delta : -s.delta)]
                            }
                          >
                            {s.delta > 0 ? "+" : "−"}
                            {pctFraction(Math.abs(s.delta))}
                          </span>
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-1 text-right text-[11px] text-muted-foreground" colSpan={2}>
                        categorical
                      </td>
                      <td className="py-1 text-right text-[11px] tabular-nums">
                        {s.transitions ? `${s.transitions.changed} changed` : "—"}
                      </td>
                    </>
                  )}
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {s.pairedCount}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Layer 4: case table ───────────────────────────────────────────────────

function scorerCellText(c: ScorerCellComparison): string {
  const v = (x: number | boolean | string | null) =>
    x === null
      ? "—"
      : typeof x === "boolean"
        ? x
          ? "pass"
          : "fail"
        : typeof x === "number"
          ? Number.isInteger(x)
            ? String(x)
            : x.toFixed(2)
          : x;
  return `${v(c.baselineValue)} → ${v(c.candidateValue)}`;
}

function CaseRow({ r, onOpen }: { r: CompareResultRow; onOpen: () => void }) {
  const cmp = r.comparison;
  const st = caseStatus(r);
  const changedCells = (cmp?.scorerCells ?? []).filter(
    (c) =>
      c.classification === "regressed" ||
      c.classification === "improved" ||
      c.classification === "changed" ||
      c.reason,
  );
  const mainDelta = cmp?.mainScore.delta ?? null;
  const mainChange = cmp?.caseChange ?? null;
  return (
    <TR interactive onClick={onOpen}>
      {/* Input (primary) + expected + id secondary */}
      <Td>
        <div className="max-w-[280px] truncate" title={r.input}>
          {truncate(r.input, 120)}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-mono">{r.testCaseId}</span>
          {r.provenance && <span title="Saved from a production trace">· from trace</span>}
        </div>
      </Td>
      {/* Output change */}
      <Td className="max-w-[220px]">
        {r.outputChanged === false ? (
          <span className="text-[11px] text-muted-foreground">No output change</span>
        ) : (
          <div className="text-[11px]">
            <div className="truncate text-muted-foreground" title={r.baselineOutput ?? ""}>
              {r.baselineOutput === null ? "—" : truncate(r.baselineOutput, 40)}
            </div>
            <div className="truncate" title={r.candidateOutput ?? ""}>
              {r.candidateOutput === null ? "—" : truncate(r.candidateOutput, 40)}
            </div>
          </div>
        )}
      </Td>
      {/* Main score (typed) */}
      <Td className="text-[11px]">
        {cmp ? (
          <>
            <div className="tabular-nums">
              {fmtScore(cmp.mainScore.baseline)} → {fmtScore(cmp.mainScore.candidate)}
            </div>
            {mainChange && (
              <div className={CHANGE_LABEL[mainChange].className}>
                {mainDelta !== null && mainDelta !== 0
                  ? `${mainDelta > 0 ? "+" : "−"}${pctFraction(Math.abs(mainDelta))} · `
                  : ""}
                {CHANGE_LABEL[mainChange].label}
              </div>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Td>
      {/* Scorer changes (only changed/error cells) */}
      <Td className="text-[11px]">
        {changedCells.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : changedCells.length <= 2 ? (
          <div className="space-y-0.5">
            {changedCells.map((c) => (
              <div key={`${c.scorerName}@${c.scorerVersion}`} className="tabular-nums">
                <span className="text-muted-foreground">{c.scorerName}</span> {scorerCellText(c)}
              </div>
            ))}
          </div>
        ) : (
          <span className={SENTIMENT_CLASS.bad}>
            {cmp?.regressedCellCount ?? 0} scorer regressions
          </span>
        )}
      </Td>
      {/* Duration */}
      <Td className="whitespace-nowrap text-right text-[11px] tabular-nums">
        {cmp?.durationDeltaMs != null ? (
          <span className={SENTIMENT_CLASS[changeSentiment(-cmp.durationDeltaMs)]}>
            {fmtMs(cmp.durationMs ?? null)}
          </span>
        ) : (
          <span className="text-muted-foreground">{fmtMs(cmp?.durationMs ?? null)}</span>
        )}
      </Td>
      {/* Cost */}
      <Td className="whitespace-nowrap text-right text-[11px] tabular-nums">
        {r.candidateCost === null && r.baselineCost === null ? (
          <span className="text-muted-foreground">Unknown</span>
        ) : (
          <span>{fmtCost(r.candidateCost)}</span>
        )}
      </Td>
      {/* Status */}
      <Td>
        <span className={cn("text-[11px]", STATUS_LABEL[st].className)}>
          {STATUS_LABEL[st].label}
        </span>
      </Td>
    </TR>
  );
}

// ── The page ──────────────────────────────────────────────────────────────

export function CompareRunsView({
  projectId,
  candidateId,
  baselineId,
  onChange,
}: {
  projectId: string;
  candidateId: string | null;
  baselineId: string | null;
  onChange: (baseline: string | null, candidate: string | null) => void;
}) {
  const compare = useCompareRuns(projectId, candidateId, baselineId);
  const data = compare.data;
  const [filter, setFilter] = React.useState<CaseFilterId>("all");
  const [sort, setSort] = React.useState<CaseSortId>("default");
  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);
  const [traceView, setTraceView] = React.useState<{ traceId: string; label: string } | null>(null);

  const crossEval = !!data && data.candidate.evaluationId !== data.baseline.evaluationId;

  const rows = React.useMemo(() => data?.results ?? [], [data]);
  const durationWorsened = (data?.comparison.duration.deltaMs ?? 0) > 0;
  const verdict = data
    ? deriveVerdict(data.comparison, data.candidate.status, data.baseline.status, durationWorsened)
    : null;
  const counts = React.useMemo(() => filterCounts(rows), [rows]);
  const visible = React.useMemo(
    () =>
      sortCases(
        rows.filter((r) => matchesFilter(r, filter)),
        sort,
      ),
    [rows, filter, sort],
  );
  const openCase = openCaseId ? (rows.find((r) => r.testCaseId === openCaseId) ?? null) : null;

  return (
    <div className="flex h-full flex-col text-[12px]">
      <ProjectBreadcrumb projectId={projectId} current="Compare runs" />

      {/* Chooser — Baseline first, then Candidate */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <RunChooser
          projectId={projectId}
          label="Baseline"
          seedEvaluationId={data?.baseline.evaluationId ?? null}
          runId={baselineId}
          otherRunId={candidateId}
          onPick={(id) => onChange(id, candidateId)}
        />
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <RunChooser
          projectId={projectId}
          label="Candidate"
          seedEvaluationId={data?.candidate.evaluationId ?? null}
          runId={candidateId}
          otherRunId={baselineId}
          onPick={(id) => onChange(baselineId, id)}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          disabled={!candidateId || !baselineId}
          onClick={() => onChange(candidateId, baselineId)}
          title="Swap baseline and candidate"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
          Swap
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {!candidateId || !baselineId ? (
          <EmptyState>Pick a baseline and a candidate run to compare.</EmptyState>
        ) : candidateId === baselineId ? (
          <EmptyState>Pick two different runs.</EmptyState>
        ) : compare.isLoading ? (
          <EmptyState>Comparing…</EmptyState>
        ) : compare.error || !data ? (
          <EmptyState>Couldn’t compare these runs.</EmptyState>
        ) : (
          <>
            {/* Layer 1 — identity, Baseline → Candidate */}
            <div className="flex flex-col items-stretch gap-2 sm:flex-row">
              <RunHeaderCard run={data.baseline} role="Baseline" crossEval={crossEval} />
              <ArrowRight
                className="mx-auto h-4 w-4 shrink-0 rotate-90 self-center text-muted-foreground sm:mt-6 sm:rotate-0"
                aria-hidden
              />
              <RunHeaderCard run={data.candidate} role="Candidate" crossEval={crossEval} />
            </div>

            {/* Comparability first, straight from the backend discriminant. A
                non-trustworthy comparison (cross-evaluation, mismatched snapshot,
                a still-running run) gets the strong banner and NO colored verdict —
                its deltas still render below as neutral metrics, never as a
                ship / no-ship result. */}
            <ComparabilityBanner
              state={data.comparison.state}
              reasons={data.comparison.reasons}
            />

            {/* Layer 2 — verdict (only when the comparison is authoritative) */}
            {verdict && data.comparison.state === "trustworthy" && (
              <div
                className={cn(
                  "rounded border px-3 py-2",
                  VERDICT_TONE[VERDICT_META[verdict.verdict].tone],
                )}
              >
                <div className="text-[13px] font-semibold">
                  {VERDICT_META[verdict.verdict].label}
                </div>
                <div className="mt-0.5 space-y-0.5 text-[11px] leading-relaxed">
                  {verdict.reasons.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Layer 3 — aggregate metrics + per-scorer */}
            <DecisionMetrics
              projectId={projectId}
              comparison={data.comparison}
              candidate={data.candidate}
              baseline={data.baseline}
              rows={rows}
            />
            <ScorerSummary comparison={data.comparison} />

            {/* Layer 4 — case table */}
            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[12px] font-medium">Test cases</div>
                  <div className="text-[11px] text-muted-foreground">
                    Each row is one dataset input run through both the baseline and candidate ·{" "}
                    {data.baseline.datasetVersionLabel === data.candidate.datasetVersionLabel
                      ? data.candidate.datasetVersionLabel
                      : `${data.baseline.datasetVersionLabel} vs ${data.candidate.datasetVersionLabel}`}{" "}
                    · matched by test-case id
                  </div>
                </div>
                <Select value={sort} onValueChange={(v) => setSort(v as CaseSortId)}>
                  <SelectTrigger className="h-7 w-[190px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CASE_SORTS.map((s) => (
                      <SelectItem key={s.id} value={s.id} className="text-[12px]">
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Filters with counts */}
              <div className="mb-1.5 flex flex-wrap gap-1">
                {CASE_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors",
                      filter === f.id
                        ? "border-foreground/30 bg-muted text-foreground"
                        : "border-input text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.label}
                    <span className="tabular-nums text-muted-foreground">{counts[f.id]}</span>
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto rounded border border-border">
                <Table>
                  <THead>
                    <TRHead>
                      <Th>Input</Th>
                      <Th>Output change</Th>
                      <Th className="w-[130px]">Main score</Th>
                      <Th className="w-[150px]">Scorer changes</Th>
                      <Th className="w-[90px] text-right">Duration</Th>
                      <Th className="w-[90px] text-right">Cost</Th>
                      <Th className="w-[110px]">Status</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {visible.length === 0 ? (
                      <tr>
                        <td colSpan={7}>
                          <EmptyState>No cases match this filter.</EmptyState>
                        </td>
                      </tr>
                    ) : (
                      visible.map((r) => (
                        <CaseRow
                          key={r.testCaseId}
                          r={r}
                          onOpen={() => setOpenCaseId(r.testCaseId)}
                        />
                      ))
                    )}
                  </TBody>
                </Table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Layer 5 — selected-case diagnosis drawer */}
      {openCase && data && (
        <CompareCaseDrawer
          projectId={projectId}
          row={openCase}
          candidate={data.candidate}
          baseline={data.baseline}
          onClose={() => setOpenCaseId(null)}
          traceSlot={
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                disabled={!openCase.candidateTraceId}
                onClick={() =>
                  openCase.candidateTraceId &&
                  setTraceView({ traceId: openCase.candidateTraceId, label: "Candidate trace" })
                }
              >
                Open candidate trace
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                disabled={!openCase.baselineTraceId}
                onClick={() =>
                  openCase.baselineTraceId &&
                  setTraceView({ traceId: openCase.baselineTraceId, label: "Baseline trace" })
                }
              >
                Open baseline trace
              </Button>
              {!openCase.candidateTraceId && !openCase.baselineTraceId && (
                <span className="text-[11px] text-muted-foreground">
                  No trace was emitted for this case.
                </span>
              )}
            </div>
          }
        />
      )}

      {/* Trace viewer — opens over the drawer; switching baseline/candidate keeps the
          case drawer mounted underneath. */}
      {traceView && (
        <TraceViewerPanel
          key={traceView.traceId}
          projectId={projectId}
          traceId={traceView.traceId}
          headerIdentity={{ label: traceView.label, value: traceView.traceId }}
          onClose={() => setTraceView(null)}
          onNavigate={() => {}}
          canNavigateUp={false}
          canNavigateDown={false}
        />
      )}
    </div>
  );
}
