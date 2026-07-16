"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  GitCompare,
  Layers,
  ListChecks,
  Ruler,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { HighlightedCode } from "@/features/offline-eval/components/syntax";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  EmptyState,
  Timestamp,
  useRowSelection,
  SelectAllHeaderCell,
  SelectRowCell,
  BulkActionBar,
} from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { PassRate } from "../components/pass-rate";
import { pctFraction, SENTIMENT_CLASS } from "@/features/offline-eval/utils";
import {
  useDatasets,
  useEvaluationRuns,
  useScorers,
  useScorer,
  useDeleteRuns,
  type ScorerRegistryRow,
} from "../hooks";
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
      {tab === "scorers" && <ScorersTab projectId={projectId} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs — the flat execution list.
// ---------------------------------------------------------------------------

const RUNS_COLUMN_COUNT = 10;

/** Human elapsed duration; "—" when unknown (never 0). */
function formatElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function ScoreValue({ value }: { value: number | null }) {
  return value === null ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <>{pctFraction(value)}</>
  );
}

/** Total run cost; "—" when no case reported a cost (never a misleading $0). */
function formatCost(cost: number | null | undefined): React.ReactNode {
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
  selected,
  onToggle,
  showEvaluation = true,
  indent = false,
}: {
  run: RunRow;
  projectId: string;
  selected: boolean;
  onToggle: () => void;
  showEvaluation?: boolean;
  indent?: boolean;
}) {
  const router = useRouter();
  return (
    <TR
      interactive
      selected={selected}
      onClick={() => router.push(`/projects/${projectId}/evaluations/${r.id}`)}
    >
      <SelectRowCell
        checked={selected}
        onToggle={onToggle}
        label={`Select ${r.evaluationName} #${r.runNumber}`}
      />
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
      <Td>
        <RunStatusBadge status={r.status} />
      </Td>
      <Td className="text-right tabular-nums">
        {r.errorCount === 0 ? <span className="text-muted-foreground">—</span> : r.errorCount}
      </Td>
      <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
        {formatElapsed(r.elapsedMs)}
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
 *  (passed, cost, errors, duration) and averaged for the score. */
function aggregateGroup(runs: RunRow[]) {
  let passedCount = 0,
    failedCount = 0,
    erroredCount = 0,
    notScoredCount = 0,
    errors = 0,
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
    errors += r.errorCount ?? 0;
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
    errors,
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
  selected,
  indeterminate,
  onToggleSelect,
}: {
  group: RunGroup;
  isOpen: boolean;
  onToggle: () => void;
  projectId: string;
  selected: boolean;
  indeterminate: boolean;
  onToggleSelect: () => void;
}) {
  const router = useRouter();
  const latest = group.runs[0];
  const earlier = group.runs.length - 1;
  const agg = React.useMemo(() => aggregateGroup(group.runs), [group.runs]);
  return (
    <TR className="bg-muted/40 font-medium">
      {/* Group selection: selects/deselects every run in the lineage at once. */}
      <td
        className="w-8 border-r border-border/50 px-3 py-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={selected}
          indeterminate={indeterminate}
          onCheckedChange={onToggleSelect}
          aria-label={
            selected
              ? `Deselect all runs in ${group.evaluationName}`
              : `Select all runs in ${group.evaluationName}`
          }
        />
      </td>
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
      <Td>
        <RunStatusBadge status={latest.status} />
        <AggCaption>latest</AggCaption>
      </Td>
      <Td className="text-right tabular-nums">
        {agg.errors === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            {agg.errors}
            <AggCaption>total</AggCaption>
          </>
        )}
      </Td>
      <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
        {formatElapsed(agg.durationMs)}
        {agg.durationMs !== null && <AggCaption>total</AggCaption>}
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
  const router = useRouter();
  const searchParams = useSearchParams();
  // Scoping the list to one evaluation lineage lives in the URL (?evaluation=<id>) so
  // browser back/forward and sharing work.
  const scopedEvalId = searchParams.get("evaluation");

  const { toast } = useToast();
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

  const runIds = React.useMemo(() => runs.map((r) => r.id), [runs]);
  const sel = useRowSelection(runIds);
  const deleteRuns = useDeleteRuns(projectId);
  const deleteSelected = () => {
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Delete ${ids.length} run${ids.length === 1 ? "" : "s"}? This can't be undone.`,
      )
    )
      return;
    deleteRuns.mutate(ids, {
      onSuccess: () => {
        sel.clear();
        toast({
          title: `Deleted ${ids.length} run${ids.length === 1 ? "" : "s"}`,
          tone: "success",
        });
      },
      onError: () => toast({ title: "Could not delete runs", tone: "warning" }),
    });
  };

  // Comparison is an action: select exactly two runs to compare. Newer → candidate,
  // older → baseline (by start time); the compare page makes roles explicit + swappable.
  const comparePair = React.useMemo(() => {
    const chosen = runs.filter((r) => sel.has(r.id));
    if (chosen.length !== 2) return null;
    const [newer, older] = [...chosen].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return { candidate: newer.id, baseline: older.id };
  }, [runs, sel]);
  const openCompare = () => {
    if (!comparePair) return;
    router.push(
      `/projects/${projectId}/evaluations/compare?baseline=${comparePair.baseline}&candidate=${comparePair.candidate}`,
    );
  };

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

      <BulkActionBar
        count={sel.count}
        onDelete={deleteSelected}
        onClear={sel.clear}
        extra={
          comparePair && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[12px]"
              onClick={openCompare}
            >
              <GitCompare className="h-3.5 w-3.5" aria-hidden />
              Compare
            </Button>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <SelectAllHeaderCell
                checked={sel.allSelected}
                indeterminate={sel.someSelected}
                onToggle={sel.toggleAll}
              />
              <Th>Evaluation / Run</Th>
              <Th>Dataset</Th>
              <Th className="w-[110px] text-right">Main score</Th>
              <Th className="w-[100px] text-right">Passed</Th>
              <Th className="w-[100px] text-right">Cost</Th>
              <Th className="w-[150px]">Status</Th>
              <Th className="w-[80px] text-right">Errors</Th>
              <Th className="w-[90px] text-right">Duration</Th>
              <Th className="w-[130px] text-right">Started</Th>
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
              groups.map((g) => {
                const groupIds = g.runs.map((r) => r.id);
                const groupAll = groupIds.every((id) => sel.has(id));
                const groupSome = !groupAll && groupIds.some((id) => sel.has(id));
                return (
                  <React.Fragment key={g.evaluationId}>
                    <GroupHeaderRow
                      group={g}
                      isOpen={expanded.has(g.evaluationId)}
                      onToggle={() => toggleGroup(g.evaluationId)}
                      projectId={projectId}
                      selected={groupAll}
                      indeterminate={groupSome}
                      onToggleSelect={() => sel.setMany(groupIds, !groupAll)}
                    />
                    {expanded.has(g.evaluationId) &&
                      g.runs.map((r) => (
                        <RunTableRow
                          key={r.id}
                          run={r}
                          projectId={projectId}
                          selected={sel.has(r.id)}
                          onToggle={() => sel.toggle(r.id)}
                          showEvaluation={false}
                          indent
                        />
                      ))}
                  </React.Fragment>
                );
              })
            ) : (
              runs.map((r) => (
                <RunTableRow
                  key={r.id}
                  run={r}
                  projectId={projectId}
                  selected={sel.has(r.id)}
                  onToggle={() => sel.toggle(r.id)}
                />
              ))
            )}
          </TBody>
        </Table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Scorers — read-only registry, aggregated from reported runs. Master-detail,
// echoing the prototype: a table on the left, a detail aside on the right.
//
// A scorer's definition — what it measures, its type, scope, and score format —
// lives in the customer's SDK code and is never reported to the server, so the
// server-backed registry carries only the aggregates it can see (name, version,
// score count, error rate). The detail aside surfaces those and names the SDK as
// the source of truth for the rest, rather than fabricating descriptive text.
// ---------------------------------------------------------------------------

// +1 for the leading selection checkbox column.
const SCORERS_COLUMN_COUNT = 5;

const VALUE_TYPE_LABEL: Record<ScorerRegistryRow["valueType"], string> = {
  numeric: "Numeric",
  boolean: "Boolean",
  categorical: "Categorical",
  mixed: "Mixed",
  unknown: "Unknown",
};

const DIRECTION_LABEL: Record<NonNullable<ScorerRegistryRow["direction"]>, string> = {
  higher_is_better: "Higher is better",
  lower_is_better: "Lower is better",
  none: "No direction",
};

function ScorersTab({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useScorers(projectId);
  // Memoized so the derived id list (and therefore row selection) is stable
  // across renders rather than churning on a fresh array identity.
  const allScorers = React.useMemo(() => data?.data ?? [], [data]);
  const [keyword, setKeyword] = React.useState("");
  const scorers = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return allScorers;
    return allScorers.filter(
      (s) => s.name.toLowerCase().includes(q) || s.version.toLowerCase().includes(q),
    );
  }, [allScorers, keyword]);

  // A clicked scorer opens the detail panel (the right slide-in, no backdrop) rather
  // than a persistent split-pane.
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const active = allScorers.find((s) => `${s.name}@${s.version}` === openKey) ?? null;

  // Checkbox selection, independent of which scorer the panel is showing. The registry
  // is derived from reported runs, so there is nothing to delete — the bar offers
  // selection + Clear only.
  const scorerKeys = React.useMemo(() => scorers.map((s) => `${s.name}@${s.version}`), [scorers]);
  const sel = useRowSelection(scorerKeys);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border bg-background px-3 py-1.5">
        <div className="relative min-w-[12rem] max-w-md flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search scorers..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="h-8 pl-8 text-[12px]"
          />
        </div>
      </div>
      <BulkActionBar count={sel.count} onClear={sel.clear} />
      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <SelectAllHeaderCell
                checked={sel.allSelected}
                indeterminate={sel.someSelected}
                onToggle={sel.toggleAll}
              />
              <Th>Scorer</Th>
              <Th className="w-[110px]">Output</Th>
              <Th className="w-[120px] text-right">Scores</Th>
              <Th className="w-[120px] text-right">Error rate</Th>
            </TRHead>
          </THead>
          <TBody>
            {isLoading ? (
              <Cell colSpan={SCORERS_COLUMN_COUNT}>
                <EmptyState>Loading scorers...</EmptyState>
              </Cell>
            ) : error ? (
              <Cell colSpan={SCORERS_COLUMN_COUNT}>
                <EmptyState>Error loading scorers</EmptyState>
              </Cell>
            ) : allScorers.length === 0 ? (
              <Cell colSpan={SCORERS_COLUMN_COUNT}>
                <EmptyState>
                  No scorers yet. Scorers are defined in your SDK code and appear here once a run
                  reports them.
                </EmptyState>
              </Cell>
            ) : scorers.length === 0 ? (
              <Cell colSpan={SCORERS_COLUMN_COUNT}>
                <EmptyState>No scorers match “{keyword}”.</EmptyState>
              </Cell>
            ) : (
              scorers.map((s) => {
                const key = `${s.name}@${s.version}`;
                return (
                  <TR
                    key={key}
                    interactive
                    selected={key === openKey}
                    onClick={() => setOpenKey(key)}
                  >
                    <SelectRowCell
                      checked={sel.has(key)}
                      onToggle={() => sel.toggle(key)}
                      label={`Select ${s.name} ${s.version}`}
                    />
                    <Td>
                      <span className="flex items-baseline gap-1.5">
                        <span className="font-medium">{s.name}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {fmtScorerVersion(s.version)}
                        </span>
                      </span>
                    </Td>
                    <Td>
                      <Badge variant="outline">{VALUE_TYPE_LABEL[s.valueType]}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {s.scoreCount}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {s.errorRate === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={SENTIMENT_CLASS.bad}>
                          {(s.errorRate * 100).toFixed(1)}%
                        </span>
                      )}
                    </Td>
                  </TR>
                );
              })
            )}
          </TBody>
        </Table>
      </div>

      {active && (
        <ScorerDetailPanel
          key={`${active.name}@${active.version}`}
          projectId={projectId}
          scorer={active}
          onClose={() => setOpenKey(null)}
        />
      )}
    </div>
  );
}

/** Display a scorer version as "v1" — prefix a bare numeric version with "v"; leave a
 *  sentinel like "unversioned" or an already-prefixed "v3" untouched. */
function fmtScorerVersion(v: string): string {
  return /^\d/.test(v) ? `v${v}` : v;
}

const OUTPUT_TYPE_LABEL: Record<"score" | "classification", string> = {
  score: "Score",
  classification: "Classification",
};
const LANGUAGE_LABEL: Record<"python" | "typescript", string> = {
  python: "Python",
  typescript: "TypeScript",
};

/** The scorer's type — declared by the SDK, or derived from which definition fields it
 *  reported (code source ⇒ code; model/messages ⇒ judge). Never guessed from the name. */
function scorerKind(s: ScorerRegistryRow): "llm_judge" | "code" | null {
  if (s.scorerType) return s.scorerType;
  if (s.sourceCode) return "code";
  if (s.model || s.messages) return "llm_judge";
  return null;
}

/** The precise type shown at the top of the definition section and in the header:
 *  "LLM judge" for a judge, the language ("Python"/"TypeScript") for a code scorer. */
function definitionTypeLabel(
  s: ScorerRegistryRow,
  kind: "llm_judge" | "code" | null,
): string | null {
  if (kind === "llm_judge") return "LLM judge";
  if (kind === "code") return s.language ? LANGUAGE_LABEL[s.language] : "Code";
  return null;
}

/** Output type (Score / Classification): the SDK's declared value wins; otherwise it's
 *  inferred from the declared/observed value type, and flagged as inferred. */
function outputTypeOf(s: ScorerRegistryRow): { text: string; inferred: boolean } | null {
  if (s.outputType) return { text: OUTPUT_TYPE_LABEL[s.outputType], inferred: false };
  const vt =
    s.declaredValueType ??
    (s.valueType !== "unknown" && s.valueType !== "mixed" ? s.valueType : null);
  if (vt === "categorical") return { text: "Classification", inferred: true };
  if (vt === "numeric" || vt === "boolean") return { text: "Score", inferred: true };
  return null;
}

/** For a field the SDK does not (yet) register — shown as a plain em dash. */
function NotProvided() {
  return <span className="text-muted-foreground">—</span>;
}

/** Bordered card with a muted header strip — mirrors the detector detail panel. */
function ScorerCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">{title}</span>
        {action}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

/** A labelled fact row inside a card. */
function ScorerFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-0.5">
      <dt className="shrink-0 text-[11px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-[12px]">{children}</dd>
    </div>
  );
}

/**
 * Read-only scorer detail — a bigger, detector-style subpage (mirrors DetectorPanel's
 * 70%-width right slide-in with bordered cards). It does NOT dim/blur the page behind it
 * and closes on Escape or ✕. A scorer is defined in the customer's SDK; TraceRoot shows
 * ONLY what the SDK reported (see offline-eval/sdk-ask/scorer-definition-reporting.md) —
 * anything unreported reads "Not provided by SDK", never invented from the name.
 */
export function ScorerDetailPanel({
  projectId,
  scorer,
  onClose,
}: {
  projectId: string;
  scorer: ScorerRegistryRow;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const kind = scorerKind(scorer);

  return (
    <div
      role="dialog"
      aria-label="Scorer detail"
      className="animate-slide-in-right fixed bottom-0 right-0 top-0 z-50 flex w-[70%] max-w-[980px] flex-col border-l border-border bg-background shadow-xl"
    >
      {/* Header — detector-panel style */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/30 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Ruler className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium">Scorer</span>
          <span className="truncate text-[13px] text-muted-foreground">{scorer.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {fmtScorerVersion(scorer.version)}
          </span>
          {definitionTypeLabel(scorer, kind) && (
            <Badge variant="outline">{definitionTypeLabel(scorer, kind)}</Badge>
          )}
          <CopyButton
            value={`${scorer.name}@${scorer.version}`}
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            iconClassName="h-3 w-3"
            title="Copy scorer id"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto text-[12px]">
        <ScorerDetail projectId={projectId} scorer={scorer} kind={kind} />
      </div>
    </div>
  );
}

function ScorerDetail({
  projectId,
  scorer,
  kind,
}: {
  projectId: string;
  scorer: ScorerRegistryRow;
  kind: "llm_judge" | "code" | null;
}) {
  const maxCount = scorer.distribution?.reduce((m, d) => Math.max(m, d.count), 0) ?? 0;
  const family = useScorer(projectId, scorer.name);
  const versions = family.data?.versions ?? [];
  const ot = outputTypeOf(scorer);
  const metadataText =
    scorer.metadata != null &&
    (typeof scorer.metadata !== "object" || Object.keys(scorer.metadata).length > 0)
      ? JSON.stringify(scorer.metadata, null, 2)
      : null;

  const typeLabel = definitionTypeLabel(scorer, kind);
  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Definition — leads with the exact type: LLM judge, Python, or TypeScript. */}
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold">Definition</h3>
        <span className="text-[13px] font-medium text-foreground">{typeLabel ?? "—"}</span>
      </div>
      {/* Type-specific body */}
      {kind === "code" ? (
        <ScorerCard
          title="Source"
          action={
            scorer.sourceCode ? (
              <CopyButton
                value={scorer.sourceCode}
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                iconClassName="h-3 w-3"
                title="Copy code"
              />
            ) : undefined
          }
        >
          {scorer.sourceCode ? (
            <HighlightedCode
              code={scorer.sourceCode}
              className="max-h-[45vh] overflow-auto whitespace-pre font-mono text-[11px] leading-relaxed"
            />
          ) : (
            <NotProvided />
          )}
        </ScorerCard>
      ) : kind === "llm_judge" ? (
        <>
          <ScorerCard title="Model">
            {scorer.model ? (
              <span className="font-mono text-[12px]">{scorer.model}</span>
            ) : (
              <NotProvided />
            )}
          </ScorerCard>
          <ScorerCard title="Messages">
            {scorer.messages && scorer.messages.length > 0 ? (
              <div className="flex flex-col gap-2">
                {scorer.messages.map((m, i) => (
                  <div key={i} className="border border-border">
                    <div className="border-b border-border bg-muted/30 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {m.role}
                    </div>
                    <pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                      {m.content}
                    </pre>
                  </div>
                ))}
              </div>
            ) : (
              <NotProvided />
            )}
          </ScorerCard>
        </>
      ) : (
        <ScorerCard title="Definition">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The SDK hasn&apos;t reported this scorer&apos;s type or definition — an LLM judge&apos;s
            model &amp; messages, or a code scorer&apos;s snippet. <NotProvided />.
          </p>
        </ScorerCard>
      )}

      {/* Shared configuration */}
      <ScorerCard title="Configuration">
        <dl>
          <ScorerFact label="Output type">
            {ot ? (
              <>
                {ot.text}
                {ot.inferred && (
                  <span className="ml-1 text-[11px] text-muted-foreground">(inferred)</span>
                )}
              </>
            ) : (
              <NotProvided />
            )}
          </ScorerFact>
          <ScorerFact label="Pass threshold">
            {scorer.threshold !== null ? (
              <span className="tabular-nums">{scorer.threshold}</span>
            ) : (
              <NotProvided />
            )}
          </ScorerFact>
          <ScorerFact label="Direction">
            {scorer.direction ? DIRECTION_LABEL[scorer.direction] : <NotProvided />}
          </ScorerFact>
          <ScorerFact label="Description">
            {scorer.description ? scorer.description : <NotProvided />}
          </ScorerFact>
        </dl>
      </ScorerCard>

      {/* Metadata */}
      <ScorerCard title="Metadata">
        {metadataText ? (
          <HighlightedCode
            code={metadataText}
            className="max-h-[30vh] overflow-auto whitespace-pre font-mono text-[11px] leading-relaxed"
          />
        ) : (
          <NotProvided />
        )}
      </ScorerCard>

      {/* Observed usage — honest stats derived from reported scores. */}
      <ScorerCard title="Observed usage">
        <dl>
          <ScorerFact label="Evaluations">
            <span className="tabular-nums">{scorer.evaluationCount}</span>
          </ScorerFact>
          <ScorerFact label="Runs">
            <span className="tabular-nums">{scorer.runCount}</span>
          </ScorerFact>
          <ScorerFact label="Scored results">
            <span className="tabular-nums">{scorer.scoreCount.toLocaleString("en-US")}</span>
          </ScorerFact>
          {scorer.numeric && (
            <>
              <ScorerFact label="Mean">
                <span className="tabular-nums">{scorer.numeric.mean.toFixed(3)}</span>
              </ScorerFact>
              <ScorerFact label="Range">
                <span className="tabular-nums">
                  {scorer.numeric.min.toFixed(2)} – {scorer.numeric.max.toFixed(2)}
                </span>
              </ScorerFact>
            </>
          )}
          {scorer.passRate !== null && (
            <ScorerFact label="Pass rate">
              <span className="tabular-nums">{(scorer.passRate * 100).toFixed(1)}%</span>
            </ScorerFact>
          )}
          <ScorerFact label="Error rate">
            {scorer.errorCount === 0 ? (
              <span className="tabular-nums text-muted-foreground">0%</span>
            ) : (
              <span className={cn("tabular-nums", SENTIMENT_CLASS.bad)}>
                {(scorer.errorRate * 100).toFixed(1)}% ({scorer.errorCount} of {scorer.scoreCount})
              </span>
            )}
          </ScorerFact>
          <ScorerFact label="Last used">
            {scorer.lastUsed ? (
              <Timestamp iso={scorer.lastUsed} className="inline" />
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </ScorerFact>
        </dl>

        {scorer.distribution && scorer.distribution.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] text-muted-foreground">Score distribution</div>
            <ul className="flex flex-col gap-1.5">
              {scorer.distribution.map((d) => (
                <li key={d.label} className="flex items-center gap-2 text-[11px]">
                  <span className="w-24 shrink-0 truncate" title={d.label}>
                    {d.label}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-foreground/70"
                      style={{ width: `${maxCount > 0 ? (d.count / maxCount) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                    {d.count}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {scorer.recentErrors.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] text-muted-foreground">Recent scorer errors</div>
            <ul className="flex flex-col gap-1.5">
              {scorer.recentErrors.map((e, i) => (
                <li
                  key={i}
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
                >
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {versions.length > 1 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] text-muted-foreground">Version history</div>
            <ul className="flex flex-col gap-0.5">
              {versions.map((v) => (
                <li
                  key={v.version}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-[11px]",
                    v.version === scorer.version && "bg-muted/60",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium">{fmtScorerVersion(v.version)}</span>
                    {v.version === scorer.version && (
                      <span className="text-[10px] text-muted-foreground">viewing</span>
                    )}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {v.scoreCount} scored{v.lastUsed ? " · " : ""}
                    {v.lastUsed && <Timestamp iso={v.lastUsed} className="inline" />}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </ScorerCard>
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
