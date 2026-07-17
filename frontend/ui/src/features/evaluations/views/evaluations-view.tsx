"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Layers, ListChecks, Ruler } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { DATE_FILTER_OPTIONS, type DateFilterOption } from "@/lib/date-filter";
import { Table, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { EmptyState, Timestamp } from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { PassRate } from "../components/pass-rate";
import { pctFraction } from "@/features/offline-eval/utils";
import { useDatasets, useEvaluationRuns } from "../hooks";
import { EVAL_RUN_STATUS_LABEL, type EvalRunStatus, type RunRow } from "../types";

// Run-centric: the Evaluations page is one table of immutable runs. Scorers is the
// SDK-authored catalog. There is no separate "unique evaluations", "all runs", or
// "compare" tab — lineage is reached by grouping/filtering, and comparison is an
// action that opens a shareable /evaluations/compare route.
type Tab = "evaluations" | "scorers";

const TABS: Array<{ id: Tab; label: string; icon: typeof ListChecks }> = [
  { id: "evaluations", label: "Evaluations", icon: ListChecks },
  { id: "scorers", label: "Scorers", icon: Ruler },
];

const STATUS_VARIANT: Record<EvalRunStatus, "success" | "danger" | "warning" | "default"> = {
  running: "default",
  completed: "success",
  completed_with_errors: "warning",
  failed: "danger",
  incomplete: "warning",
};

export function RunStatusBadge({ status }: { status: EvalRunStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{EVAL_RUN_STATUS_LABEL[status]}</Badge>;
}

const ALL = "__all__";

export function EvaluationsView({ projectId }: { projectId: string }) {
  const [tab, setTab] = React.useState<Tab>("evaluations");

  return (
    <div className="flex h-full flex-col text-[12px]">
      {/* Populates the app's top breadcrumb bar (workspace / project). Without a
          mounted ProjectBreadcrumb the header goes blank on this route. */}
      <ProjectBreadcrumb projectId={projectId} current="Evaluations" />
      {/* Tab bar — same shape as the Traces page's Traces/Users/Sessions bar. */}
      <div className="flex items-center justify-between border-b border-border bg-background pr-3">
        <div className="flex">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
                  active
                    ? "border-foreground bg-muted text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "evaluations" && <RunsTab projectId={projectId} />}
      {tab === "scorers" && <ScorersTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs — the flat execution list, with optional grouping by evaluation lineage.
// ---------------------------------------------------------------------------

const RUNS_COLUMN_COUNT = 8;

/** Human elapsed duration; "—" when unknown (never 0). */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function ScoreValue({ value }: { value: number | null }) {
  return value === null ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <>{pctFraction(value)}</>
  );
}

/** Total run cost; "—" when no case reported a cost (never a misleading $0). */
export function formatCost(cost: number | null | undefined): React.ReactNode {
  if (cost === null || cost === undefined) return <span className="text-muted-foreground">—</span>;
  return `$${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/**
 * One immutable run row. Shared by the flat table and grouped mode (there is no
 * second run-table implementation). `showEvaluation=false` hides the lineage line
 * inside an expanded group, where the group header already names it. Clicking the
 * evaluation name scopes the list to that lineage (?evaluation=<id>).
 */
function RunTableRow({
  run: r,
  projectId,
  showEvaluation = true,
  indent = false,
}: {
  run: RunRow;
  projectId: string;
  showEvaluation?: boolean;
  indent?: boolean;
}) {
  const router = useRouter();
  return (
    <TR interactive onClick={() => router.push(`/projects/${projectId}/evaluations/${r.id}`)}>
      <Td className={cn(indent && "pl-6")}>
        {showEvaluation && (
          <button
            type="button"
            className="rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title="Scope to this evaluation"
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/projects/${projectId}/evaluations?evaluation=${r.evaluationId}`);
            }}
          >
            {r.evaluationName}
          </button>
        )}
        <div className="text-[11px] text-muted-foreground">
          Run #{r.runNumber} · <span className="font-mono">{r.candidateVersion}</span>
        </div>
      </Td>
      <Td className="text-muted-foreground">
        <div>{r.datasetName}</div>
        <div className="text-[11px]">{r.datasetVersionLabel}</div>
      </Td>
      <Td className="text-right tabular-nums">
        <ScoreValue value={r.mainScore} />
      </Td>
      <Td className="text-right tabular-nums">
        <PassRate counts={r} />
      </Td>
      <Td className="text-right tabular-nums text-muted-foreground">{formatCost(r.cost)}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
        {formatElapsed(r.elapsedMs)}
      </Td>
      <Td>
        <RunStatusBadge status={r.status} />
      </Td>
      <Td className="whitespace-nowrap text-right text-muted-foreground">
        <Timestamp iso={r.startedAt} />
      </Td>
    </TR>
  );
}

/** Newest run per evaluation lineage (runs arrive newest-first), keeping the latest
 *  even when it's running/failed — never silently substituting an older one. */
function latestPerEvaluation(runs: RunRow[]): RunRow[] {
  const seen = new Set<string>();
  const out: RunRow[] = [];
  for (const r of runs) {
    if (!seen.has(r.evaluationId)) {
      seen.add(r.evaluationId);
      out.push(r);
    }
  }
  return out;
}

interface RunGroup {
  evaluationId: string;
  evaluationName: string;
  datasetName: string | null;
  runs: RunRow[]; // newest first
}

/** Group by the STABLE evaluation id (not display-name text). First seen is the latest. */
function groupRunsByEvaluation(runs: RunRow[]): RunGroup[] {
  const map = new Map<string, RunGroup>();
  for (const r of runs) {
    const g = map.get(r.evaluationId);
    if (g) g.runs.push(r);
    else
      map.set(r.evaluationId, {
        evaluationId: r.evaluationId,
        evaluationName: r.evaluationName,
        datasetName: r.datasetName,
        runs: [r],
      });
  }
  return [...map.values()];
}

/** Per-lineage aggregate across a group's runs — pooled where a total is meaningful
 *  (passed, cost, duration) and averaged for the score. */
function aggregateGroup(runs: RunRow[]) {
  let passedCount = 0,
    failedCount = 0,
    erroredCount = 0,
    notScoredCount = 0,
    durationMs = 0,
    hasDuration = false,
    scoreSum = 0,
    scoreN = 0,
    cost = 0,
    hasCost = false;
  for (const r of runs) {
    passedCount += r.passedCount ?? 0;
    failedCount += r.failedCount ?? 0;
    erroredCount += r.erroredCount ?? 0;
    notScoredCount += r.notScoredCount ?? 0;
    if (r.elapsedMs != null) {
      durationMs += r.elapsedMs;
      hasDuration = true;
    }
    if (r.mainScore != null) {
      scoreSum += r.mainScore;
      scoreN += 1;
    }
    if (r.cost != null) {
      cost += r.cost;
      hasCost = true;
    }
  }
  return {
    counts: { passedCount, failedCount, erroredCount, notScoredCount },
    durationMs: hasDuration ? durationMs : null,
    avgScore: scoreN > 0 ? scoreSum / scoreN : null,
    cost: hasCost ? cost : null,
  };
}

/** Tiny muted caption under an aggregate value, naming how it was rolled up. */
function AggCaption({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-normal text-muted-foreground">{children}</div>;
}

/** Collapsed group summary: the evaluation name + run count, and per-column aggregate
 *  totals across the lineage aligned under the same columns as the run rows. Expands to
 *  the (reused) run rows. */
function GroupHeaderRow({
  group,
  isOpen,
  onToggle,
  projectId,
}: {
  group: RunGroup;
  isOpen: boolean;
  onToggle: () => void;
  projectId: string;
}) {
  const router = useRouter();
  const latest = group.runs[0];
  const earlier = group.runs.length - 1;
  const agg = React.useMemo(() => aggregateGroup(group.runs), [group.runs]);
  return (
    <TR className="bg-muted/40 font-medium">
      <Td>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggle}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={isOpen ? "Collapse" : "Expand"}
            aria-expanded={isOpen}
          >
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            className="rounded hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title="Scope to this evaluation"
            onClick={() =>
              router.push(`/projects/${projectId}/evaluations?evaluation=${group.evaluationId}`)
            }
          >
            {group.evaluationName}
          </button>
        </div>
        <div className="pl-6 text-[11px] font-normal text-muted-foreground">
          {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
          {earlier > 0 && ` · ${earlier} earlier`}
        </div>
      </Td>
      <Td className="text-muted-foreground">{group.datasetName}</Td>
      <Td className="text-right tabular-nums">
        <ScoreValue value={agg.avgScore} />
        {agg.avgScore !== null && <AggCaption>avg</AggCaption>}
      </Td>
      <Td className="text-right font-normal tabular-nums">
        <PassRate counts={agg.counts} />
      </Td>
      <Td className="text-right tabular-nums text-muted-foreground">
        {formatCost(agg.cost)}
        {agg.cost !== null && <AggCaption>total</AggCaption>}
      </Td>
      <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
        {formatElapsed(agg.durationMs)}
        {agg.durationMs !== null && <AggCaption>total</AggCaption>}
      </Td>
      <Td>
        <RunStatusBadge status={latest.status} />
        <AggCaption>latest</AggCaption>
      </Td>
      <Td className="whitespace-nowrap text-right font-normal text-muted-foreground">
        <Timestamp iso={latest.startedAt} />
        <AggCaption>latest</AggCaption>
      </Td>
    </TR>
  );
}

/** Compact lineage header shown when the list is scoped to one evaluation. */
function LineageHeader({
  run,
  runCount,
  projectId,
}: {
  run: RunRow;
  runCount: number;
  projectId: string;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-3 py-2 text-[12px]">
      <ListChecks className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="font-medium">{run.evaluationName}</span>
      <span className="text-muted-foreground">
        {run.datasetName ?? "—"} · {runCount} run{runCount === 1 ? "" : "s"} · latest
      </span>
      <RunStatusBadge status={run.status} />
      <button
        type="button"
        onClick={() => router.push(`/projects/${projectId}/evaluations`)}
        className="ml-auto rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Clear filter
      </button>
    </div>
  );
}

/** Small pill toggle for the restrained run-table controls. */
function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors",
        active
          ? "border-foreground/30 bg-muted text-foreground"
          : "border-input text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function RunsTab({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  // Scoping the list to one evaluation lineage lives in the URL (?evaluation=<id>) so
  // browser back/forward and sharing work.
  const scopedEvalId = searchParams.get("evaluation");

  const [keyword, setKeyword] = React.useState("");
  const [datasetFilter, setDatasetFilter] = React.useState(ALL);
  const [statusFilter, setStatusFilter] = React.useState(ALL);
  const [dateFilter, setDateFilter] = React.useState<DateFilterOption>(
    DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0],
  );
  const [customStart, setCustomStart] = React.useState<Date | null>(null);
  const [customEnd, setCustomEnd] = React.useState<Date | null>(null);
  const [latestOnly, setLatestOnly] = React.useState(false);
  const [groupBy, setGroupBy] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const { data: datasetsData } = useDatasets(projectId, { limit: 200 });
  const { data, isLoading, error } = useEvaluationRuns(projectId, {
    evaluation_id: scopedEvalId ?? undefined,
    search_query: keyword.trim() || undefined,
    dataset_id: datasetFilter === ALL ? undefined : datasetFilter,
    status: statusFilter === ALL ? undefined : statusFilter,
  });
  const allRuns = React.useMemo(() => data?.data ?? [], [data]);
  const filtered = !!keyword || datasetFilter !== ALL || statusFilter !== ALL;

  // Latest-only is a client-side convenience over the loaded page (newest-first);
  // grouping is client-side on the stable evaluation id. When scoped to one lineage,
  // grouping is meaningless (a single group) so it's suppressed.
  const runs = React.useMemo(
    () => (latestOnly ? latestPerEvaluation(allRuns) : allRuns),
    [allRuns, latestOnly],
  );
  const grouped = groupBy && !scopedEvalId;
  const groups = React.useMemo(() => (grouped ? groupRunsByEvaluation(runs) : []), [grouped, runs]);

  const toggleGroup = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <SearchFilterBar
        searchValue={keyword}
        onSearchChange={setKeyword}
        searchPlaceholder="Search runs..."
        dateFilter={dateFilter}
        customStartDate={customStart}
        customEndDate={customEnd}
        onDateFilterChange={setDateFilter}
        onCustomRangeChange={(s, e) => {
          setCustomStart(s);
          setCustomEnd(e);
        }}
      >
        <Select value={datasetFilter} onValueChange={setDatasetFilter}>
          <SelectTrigger className="h-7 w-[160px] text-[12px]">
            <SelectValue placeholder="Dataset" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-[12px]">
              All datasets
            </SelectItem>
            {(datasetsData?.data ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id} className="text-[12px]">
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-7 w-[170px] text-[12px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-[12px]">
              All statuses
            </SelectItem>
            {(Object.keys(EVAL_RUN_STATUS_LABEL) as EvalRunStatus[]).map((s) => (
              <SelectItem key={s} value={s} className="text-[12px]">
                {EVAL_RUN_STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Toggle active={latestOnly} onClick={() => setLatestOnly((v) => !v)}>
          Latest only
        </Toggle>
        {!scopedEvalId && (
          <Toggle active={groupBy} onClick={() => setGroupBy((v) => !v)}>
            <Layers className="h-3.5 w-3.5" aria-hidden />
            Group by evaluation
          </Toggle>
        )}

        <span className="flex-1" aria-hidden />
      </SearchFilterBar>

      {scopedEvalId && allRuns[0] && (
        <LineageHeader run={allRuns[0]} runCount={allRuns.length} projectId={projectId} />
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <Th>Evaluation / Run</Th>
              <Th>Dataset</Th>
              <Th className="w-[110px] text-right">Main score</Th>
              <Th className="w-[100px] text-right">Passed</Th>
              <Th className="w-[100px] text-right">Cost</Th>
              <Th className="w-[90px] text-right">Duration</Th>
              <Th className="w-[150px]">Status</Th>
              <Th className="w-[130px] text-right">Timestamp</Th>
            </TRHead>
          </THead>
          <TBody>
            {isLoading ? (
              <Cell colSpan={RUNS_COLUMN_COUNT}>
                <EmptyState>Loading runs...</EmptyState>
              </Cell>
            ) : error ? (
              <Cell colSpan={RUNS_COLUMN_COUNT}>
                <EmptyState>Error loading runs</EmptyState>
              </Cell>
            ) : runs.length === 0 ? (
              <Cell colSpan={RUNS_COLUMN_COUNT}>
                <EmptyState>
                  {filtered || scopedEvalId
                    ? "No runs match these filters."
                    : "No evaluation runs yet. Report a run from your SDK and it appears here."}
                </EmptyState>
              </Cell>
            ) : grouped ? (
              groups.map((g) => (
                <React.Fragment key={g.evaluationId}>
                  <GroupHeaderRow
                    group={g}
                    isOpen={expanded.has(g.evaluationId)}
                    onToggle={() => toggleGroup(g.evaluationId)}
                    projectId={projectId}
                  />
                  {expanded.has(g.evaluationId) &&
                    g.runs.map((r) => (
                      <RunTableRow
                        key={r.id}
                        run={r}
                        projectId={projectId}
                        showEvaluation={false}
                        indent
                      />
                    ))}
                </React.Fragment>
              ))
            ) : (
              runs.map((r) => <RunTableRow key={r.id} run={r} projectId={projectId} />)
            )}
          </TBody>
        </Table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Scorers — the SDK-authored catalog. Filled in a later layer; here it is a
// placeholder so the tab exists as the feature is built up.
// ---------------------------------------------------------------------------

function ScorersTab() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState>Scorers coming soon.</EmptyState>
    </div>
  );
}

function Cell({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan}>{children}</td>
    </tr>
  );
}
