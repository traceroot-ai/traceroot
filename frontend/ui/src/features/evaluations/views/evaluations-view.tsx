"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers,
  ListChecks,
  Ruler,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { ModelSelector } from "@/features/ai-assistant/components/model-selector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { DATE_FILTER_OPTIONS, type DateFilterOption } from "@/lib/date-filter";
import { useKeywordSearch } from "@/lib/hooks/use-keyword-search";
import { Table, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { HighlightedCode } from "@/features/offline-eval/components/syntax";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import {
  EmptyState,
  Timestamp,
  LineNumberedTextarea,
  useRowSelection,
  SelectAllHeaderCell,
  SelectRowCell,
  BulkActionBar,
} from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { PassRate } from "../components/pass-rate";
import { pctFraction, SENTIMENT_CLASS } from "@/features/offline-eval/utils";
import { useDatasets, useEvaluationRuns, useScorers, type ScorerRegistryRow } from "../hooks";
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

// 9 = the 8 data columns plus the row-selection checkbox column.
const RUNS_COLUMN_COUNT = 9;
// Matches the route's default `limit` (runs/route.ts) so the page-count math
// here lines up with what the server actually returns per page.
const RUNS_PAGE_LIMIT = 50;

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
  selected,
  onToggleSelect,
}: {
  run: RunRow;
  projectId: string;
  showEvaluation?: boolean;
  indent?: boolean;
  selected: boolean;
  onToggleSelect: () => void;
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
        onToggle={onToggleSelect}
        label={`Select run #${r.runNumber}`}
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
          <Link
            href={`/projects/${projectId}/evaluations/${r.id}`}
            className="rounded hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={(e) => e.stopPropagation()}
          >
            Run #{r.runNumber}
          </Link>{" "}
          · <span className="font-mono">{r.candidateVersion}</span>
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
  truncated,
  selectedIds,
  onToggleGroupSelection,
}: {
  group: RunGroup;
  isOpen: boolean;
  onToggle: () => void;
  projectId: string;
  /** True when `allRuns` is only a page of the project's runs (see `meta.total`
   *  below) — the lineage may extend beyond what's loaded, so sums here are
   *  page-local, not lineage totals. */
  truncated: boolean;
  selectedIds: Set<string>;
  onToggleGroupSelection: (ids: string[], on: boolean) => void;
}) {
  const router = useRouter();
  const latest = group.runs[0];
  const earlier = group.runs.length - 1;
  const agg = React.useMemo(() => aggregateGroup(group.runs), [group.runs]);
  const groupIds = React.useMemo(() => group.runs.map((r) => r.id), [group.runs]);
  const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedIds.has(id));
  const someSelected = !allSelected && groupIds.some((id) => selectedIds.has(id));
  // "total"/"avg" over a truncated page are page-local sums, not lineage totals —
  // label them as partial so they don't read as the whole lineage's figures.
  const totalLabel = truncated ? "partial" : "total";
  const avgLabel = truncated ? "partial avg" : "avg";
  return (
    <TR className="bg-muted/40 font-medium">
      <SelectRowCell
        checked={allSelected}
        indeterminate={someSelected}
        onToggle={() => onToggleGroupSelection(groupIds, !allSelected)}
        label={`Select all runs in ${group.evaluationName}`}
      />
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
          {truncated ? " loaded" : ""}
          {earlier > 0 && ` · ${earlier} earlier${truncated ? " (loaded)" : ""}`}
        </div>
      </Td>
      <Td className="text-muted-foreground">{group.datasetName}</Td>
      <Td className="text-right tabular-nums">
        <ScoreValue value={agg.avgScore} />
        {agg.avgScore !== null && <AggCaption>{avgLabel}</AggCaption>}
      </Td>
      <Td className="text-right font-normal tabular-nums">
        <PassRate counts={agg.counts} />
      </Td>
      <Td className="text-right tabular-nums text-muted-foreground">
        {formatCost(agg.cost)}
        {agg.cost !== null && <AggCaption>{totalLabel}</AggCaption>}
      </Td>
      <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
        {formatElapsed(agg.durationMs)}
        {agg.durationMs !== null && <AggCaption>{totalLabel}</AggCaption>}
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

  const { keyword, setKeyword, searchQuery } = useKeywordSearch();
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
  const [page, setPage] = React.useState(0);
  // Any change to scope/filters invalidates the current page — otherwise a
  // narrower filter can land on a page past the end of its (now shorter) result set.
  React.useEffect(() => {
    setPage(0);
  }, [scopedEvalId, searchQuery, datasetFilter, statusFilter]);

  const { toast } = useToast();
  const { data: datasetsData } = useDatasets(projectId, { limit: 200 });
  const { data, isLoading, error, refetch } = useEvaluationRuns(projectId, {
    evaluation_id: scopedEvalId ?? undefined,
    search_query: searchQuery,
    dataset_id: datasetFilter === ALL ? undefined : datasetFilter,
    status: statusFilter === ALL ? undefined : statusFilter,
    page,
    limit: RUNS_PAGE_LIMIT,
  });
  const allRuns = React.useMemo(() => data?.data ?? [], [data]);
  // Keys off the immediate `keyword`, not the debounced `searchQuery`, so the
  // empty-state copy doesn't flicker to "no runs yet" for the 300ms before the
  // debounced value catches up.
  const filtered = !!keyword || datasetFilter !== ALL || statusFilter !== ALL;
  // The route paginates (default 50/page, no pager in this tab) — `meta.total` is
  // the true count across the project, so we can tell whether `allRuns` is the
  // full result set or just the newest page of it. When truncated, per-lineage
  // aggregates below are page-local sums, not lineage totals, and are labeled
  // accordingly instead of silently reading as "total".
  const total = data?.meta?.total ?? allRuns.length;
  const truncated = total > allRuns.length;

  // Latest-only is a client-side convenience over the loaded page (newest-first)
  // for the FLAT table. Grouping always reflects the full loaded page — it must
  // not be built from the latest-only-reduced list, or a group would show a
  // single run captioned as if it were the lineage's roll-up. When scoped to one
  // lineage, grouping is meaningless (a single group) so it's suppressed.
  const runs = React.useMemo(
    () => (latestOnly ? latestPerEvaluation(allRuns) : allRuns),
    [allRuns, latestOnly],
  );
  const grouped = groupBy && !scopedEvalId;
  const groups = React.useMemo(
    () => (grouped ? groupRunsByEvaluation(allRuns) : []),
    [grouped, allRuns],
  );

  const toggleGroup = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Selection operates on run ids regardless of display mode: in the flat table
  // that's the (possibly latest-only-reduced) `runs`; grouped, it's every run
  // across every group (including collapsed ones), so checking a group selects
  // its member runs whether or not they're currently rendered.
  const selectableIds = React.useMemo(
    () => (grouped ? allRuns.map((r) => r.id) : runs.map((r) => r.id)),
    [grouped, allRuns, runs],
  );
  const selection = useRowSelection<string>(selectableIds);

  const handleBulkDelete = React.useCallback(async () => {
    const ids = [...selection.selected];
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const res = await fetch(`/api/projects/${projectId}/evaluations/runs/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`Failed to delete run ${id}`);
        return id;
      }),
    );
    const succeededIds = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map((r) => r.value);
    const failedCount = results.length - succeededIds.length;
    selection.setMany(succeededIds, false);
    await refetch();
    if (failedCount === 0) {
      toast({
        title: `${succeededIds.length} run${succeededIds.length === 1 ? "" : "s"} deleted`,
        tone: "success",
      });
    } else {
      toast({
        title: `${succeededIds.length} of ${results.length} runs deleted`,
        description: `${failedCount} failed to delete.`,
        tone: "warning",
      });
    }
  }, [selection, projectId, refetch, toast]);

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
            <DOMAIN_ICONS.group className="h-3.5 w-3.5" aria-hidden />
            Group by evaluation
          </Toggle>
        )}

        <span className="flex-1" aria-hidden />
      </SearchFilterBar>

      {scopedEvalId && allRuns[0] && (
        <LineageHeader run={allRuns[0]} runCount={allRuns.length} projectId={projectId} />
      )}

      {truncated && (
        <div className="border-b border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
          Showing the {allRuns.length} most recent of {total} runs. Aggregates below reflect only
          these loaded runs, not full lineage totals.
        </div>
      )}

      <BulkActionBar
        count={selection.count}
        onDelete={handleBulkDelete}
        onClear={selection.clear}
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <SelectAllHeaderCell
                checked={selection.allSelected}
                indeterminate={selection.someSelected}
                onToggle={selection.toggleAll}
              />
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
                    truncated={truncated}
                    selectedIds={selection.selected}
                    onToggleGroupSelection={selection.setMany}
                  />
                  {expanded.has(g.evaluationId) &&
                    g.runs.map((r) => (
                      <RunTableRow
                        key={r.id}
                        run={r}
                        projectId={projectId}
                        showEvaluation={false}
                        indent
                        selected={selection.has(r.id)}
                        onToggleSelect={() => selection.toggle(r.id)}
                      />
                    ))}
                </React.Fragment>
              ))
            ) : (
              runs.map((r) => (
                <RunTableRow
                  key={r.id}
                  run={r}
                  projectId={projectId}
                  selected={selection.has(r.id)}
                  onToggleSelect={() => selection.toggle(r.id)}
                />
              ))
            )}
          </TBody>
        </Table>
      </div>

      {!isLoading && !error && total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>
            Showing {page * RUNS_PAGE_LIMIT + 1}–{Math.min((page + 1) * RUNS_PAGE_LIMIT, total)} of{" "}
            {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page"
              className="rounded p-1 hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={(page + 1) * RUNS_PAGE_LIMIT >= total}
              aria-label="Next page"
              className="rounded p-1 hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Scorers — read-only registry, aggregated from reported runs. Master-detail,
// a table on the left, a detail aside on the right.
//
// A scorer's definition — what it measures, its type, scope, and score format —
// lives in the customer's SDK code and is never reported to the server, so the
// server-backed registry carries only the aggregates it can see (name, version,
// score count, error rate). The detail aside surfaces those and names the SDK as
// the source of truth for the rest, rather than fabricating descriptive text.
// ---------------------------------------------------------------------------

const SCORERS_COLUMN_COUNT = 8;

const VALUE_TYPE_LABEL: Record<ScorerRegistryRow["valueType"], string> = {
  numeric: "Numeric",
  boolean: "Boolean",
  categorical: "Categorical",
  mixed: "Mixed",
  unknown: "Unknown",
};

function ScorersTab({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useScorers(projectId);
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
  const activeIndex = scorers.findIndex((s) => `${s.name}@${s.version}` === openKey);
  const navigateScorer = (dir: "up" | "down") => {
    if (activeIndex === -1) return;
    const next = dir === "up" ? activeIndex - 1 : activeIndex + 1;
    if (next >= 0 && next < scorers.length) {
      const s = scorers[next];
      setOpenKey(`${s.name}@${s.version}`);
    }
  };

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
      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <Th>Scorer</Th>
              <Th className="w-[110px]">Output</Th>
              <Th className="w-[100px] text-right">Evaluations</Th>
              <Th className="w-[80px] text-right">Runs</Th>
              <Th className="w-[90px] text-right">Scores</Th>
              <Th className="w-[90px] text-right">Pass rate</Th>
              <Th className="w-[100px] text-right">Error rate</Th>
              <Th className="w-[140px] text-right">Last used</Th>
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
                      {s.evaluationCount}
                    </Td>
                    <Td className="text-right tabular-nums text-muted-foreground">{s.runCount}</Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {s.scoreCount.toLocaleString("en-US")}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {s.passRate === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        `${(s.passRate * 100).toFixed(1)}%`
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {s.errorRate > 0 ? (
                        <span className={SENTIMENT_CLASS.bad}>
                          {(s.errorRate * 100).toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0%</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right text-muted-foreground">
                      {s.lastUsed ? (
                        <Timestamp iso={s.lastUsed} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
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
          scorer={active}
          onClose={() => setOpenKey(null)}
          onNavigate={navigateScorer}
          canNavigateUp={activeIndex > 0}
          canNavigateDown={activeIndex !== -1 && activeIndex < scorers.length - 1}
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

/**
 * Read-only scorer detail — a bigger, detector-style subpage (mirrors DetectorPanel's
 * 70%-width right slide-in with bordered cards). It does NOT dim/blur the page behind it
 * and closes on Escape or ✕. A scorer is defined in the customer's SDK; TraceRoot shows
 * ONLY what the SDK reported (see offline-eval/sdk-ask/scorer-definition-reporting.md) —
 * anything unreported reads "Not provided by SDK", never invented from the name.
 */
export function ScorerDetailPanel({
  scorer,
  onClose,
  onNavigate,
  canNavigateUp,
  canNavigateDown,
}: {
  scorer: ScorerRegistryRow;
  onClose: () => void;
  onNavigate?: (dir: "up" | "down") => void;
  canNavigateUp?: boolean;
  canNavigateDown?: boolean;
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
        <div className="flex items-center gap-1">
          {onNavigate && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate("up")}
                disabled={!canNavigateUp}
                className="h-7 w-7 p-0"
                title="Previous scorer"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate("down")}
                disabled={!canNavigateDown}
                className="h-7 w-7 p-0"
                title="Next scorer"
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
            className="h-7 w-7 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto text-[12px]">
        <ScorerDetail scorer={scorer} kind={kind} />
      </div>
    </div>
  );
}

function ScorerDetail({
  scorer,
  kind,
}: {
  scorer: ScorerRegistryRow;
  kind: "llm_judge" | "code" | null;
}) {
  const systemPrompt = scorer.messages?.find((m) => m.role === "system")?.content ?? null;
  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Name — read-only, in the detector's editable-field chrome. */}
      <ScorerCard title="Name">
        <Input value={scorer.name} readOnly className="h-7 text-[13px]" />
      </ScorerCard>

      {/* Model — the detector's model dropdown, rendered read-only (the wrapper
          blocks pointer + focus, so it shows the model but never opens). */}
      {kind === "llm_judge" && (
        <ScorerCard title="Model">
          <div className="pointer-events-none [&_*]:pointer-events-none">
            <ModelSelector
              value={{ model: scorer.model ?? "", provider: "", source: "system", adapter: "" }}
              onChange={() => {}}
            />
          </div>
        </ScorerCard>
      )}

      {/* Prompt (LLM judge) or code snippet (code scorer). */}
      {kind === "code" ? (
        <ScorerCard
          title="Code"
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
              className="max-h-[45vh] overflow-auto whitespace-pre font-mono text-[12px] leading-relaxed"
            />
          ) : (
            <NotProvided />
          )}
        </ScorerCard>
      ) : (
        <ScorerCard title="Prompt">
          {systemPrompt ? (
            <LineNumberedTextarea
              value={systemPrompt}
              onChange={() => {}}
              readOnly
              fontClassName="text-[12px] leading-[20px]"
              aria-label="System prompt"
            />
          ) : (
            <NotProvided />
          )}
        </ScorerCard>
      )}

      {/* Pass threshold — read-only draggable bar, mirroring the detector's Sampling. */}
      <ScorerCard title="Pass threshold">
        {scorer.threshold !== null ? (
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={Math.min(1, Math.max(0, scorer.threshold))}
              readOnly
              tabIndex={-1}
              aria-label="Pass threshold"
              className="pointer-events-none flex-1 accent-foreground"
            />
            <span className="w-12 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
              {scorer.threshold}
            </span>
          </div>
        ) : (
          <NotProvided />
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
