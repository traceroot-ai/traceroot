"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  Download,
  GitCompare,
  Layers,
  ListChecks,
  Ruler,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  changeSentiment,
  pctFraction,
  SENTIMENT_CLASS,
  signedPoints,
} from "@/features/offline-eval/utils";
import {
  useDatasets,
  useEvaluationRuns,
  useScorers,
  useScorer,
  useDeleteRuns,
  type ScorerRegistryRow,
} from "../hooks";
import { EVAL_RUN_STATUS_LABEL, type EvalRunStatus, type RunRow } from "../types";
import { RunEvaluationDrawer } from "../components/run-evaluation-drawer";

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
  const [runOpen, setRunOpen] = React.useState(false);

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
        {tab === "evaluations" && (
          <Button size="sm" className="h-7 text-[12px]" onClick={() => setRunOpen(true)}>
            Run evaluation
          </Button>
        )}
      </div>

      {tab === "evaluations" && <RunsTab projectId={projectId} />}
      {tab === "scorers" && <ScorersTab projectId={projectId} />}

      <RunEvaluationDrawer projectId={projectId} open={runOpen} onOpenChange={setRunOpen} />
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

function ChangeValue({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">—</span>;
  return <span className={SENTIMENT_CLASS[changeSentiment(value)]}>{signedPoints(value)} pp</span>;
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
        <ChangeValue value={r.changeFromBaseline} />
      </Td>
      <Td className="text-right tabular-nums">
        {/* Regressed TEST CASES; "—" when there's no trustworthy baseline to count against. */}
        {r.regressedCaseCount === null || r.regressedCaseCount === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : r.regressedCaseCount === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          <span className={SENTIMENT_CLASS.bad}>{r.regressedCaseCount}</span>
        )}
      </Td>
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

/** Collapsed group summary: name, latest run + its candidate/score/change/status, and
 *  the earlier-run count. Expands to the (reused) run rows. Relocates the removed
 *  unique-evaluations tab's per-lineage aggregates. */
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
  return (
    <tr className="border-b border-border bg-muted/40">
      <td colSpan={RUNS_COLUMN_COUNT} className="px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
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
            className="rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title="Scope to this evaluation"
            onClick={() =>
              router.push(`/projects/${projectId}/evaluations?evaluation=${group.evaluationId}`)
            }
          >
            {group.evaluationName}
          </button>
          <span className="text-muted-foreground">
            {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
            {earlier > 0 && ` · ${earlier} earlier`}
          </span>
          <span className="h-3 w-px bg-border" aria-hidden />
          <span className="text-muted-foreground">
            latest Run #{latest.runNumber} ·{" "}
            <span className="font-mono">{latest.candidateVersion}</span>
          </span>
          <RunStatusBadge status={latest.status} />
          <span className="tabular-nums">
            <ScoreValue value={latest.mainScore} />
          </span>
          <span className="tabular-nums">
            <ChangeValue value={latest.changeFromBaseline} />
          </span>
        </div>
      </td>
    </tr>
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
              <Th className="w-[100px] text-right">Change</Th>
              <Th className="w-[100px] text-right">Regressions</Th>
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
                    : "No evaluation runs yet. Use Run evaluation for the SDK snippet."}
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
                        selected={sel.has(r.id)}
                        onToggle={() => sel.toggle(r.id)}
                        showEvaluation={false}
                        indent
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
  const scorers = React.useMemo(() => data?.data ?? [], [data]);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const selected =
    scorers.find((s) => `${s.name}@${s.version}` === selectedKey) ?? scorers[0] ?? null;

  // Checkbox selection, independent of which scorer the detail aside is showing.
  // The registry is derived from reported runs, so there is nothing to delete —
  // the bar offers selection + Clear only.
  const scorerKeys = React.useMemo(() => scorers.map((s) => `${s.name}@${s.version}`), [scorers]);
  const sel = useRowSelection(scorerKeys);

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left column: the selection bar stays pinned above the scrolling table. */}
      <div className="flex min-w-0 flex-1 flex-col">
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
              ) : scorers.length === 0 ? (
                <Cell colSpan={SCORERS_COLUMN_COUNT}>
                  <EmptyState>
                    No scorers yet. Scorers are defined in your SDK code and appear here once a run
                    reports them.
                  </EmptyState>
                </Cell>
              ) : (
                scorers.map((s) => {
                  const key = `${s.name}@${s.version}`;
                  return (
                    <TR
                      key={key}
                      interactive
                      selected={key === `${selected?.name}@${selected?.version}`}
                      onClick={() => setSelectedKey(key)}
                    >
                      <SelectRowCell
                        checked={sel.has(key)}
                        onToggle={() => sel.toggle(key)}
                        label={`Select ${s.name} ${s.version}`}
                      />
                      <Td>
                        <span className="flex items-baseline gap-1.5">
                          <span className="font-medium">{s.name}</span>
                          <span className="text-[11px] text-muted-foreground">{s.version}</span>
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
      </div>

      <aside
        aria-label="Scorer detail"
        className="w-[360px] shrink-0 overflow-auto border-l border-border"
      >
        {selected ? (
          <ScorerDetail
            key={`${selected.name}@${selected.version}`}
            projectId={projectId}
            scorer={selected}
          />
        ) : (
          <EmptyState>Select a scorer to see what it reports.</EmptyState>
        )}
      </aside>
    </div>
  );
}

function ScorerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-3 py-2.5">
      <h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/** A labelled scalar for the config/stats rows. */
function ScorerFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-[12px] tabular-nums">{children}</dd>
    </div>
  );
}

/** For a field the SDK does not (yet) register — shown honestly, never fabricated. */
function NotProvided() {
  return <span className="italic text-muted-foreground">Not provided by SDK</span>;
}

/**
 * Scorer detail, organized around four questions — what it measures / reads / how it
 * works / where it's used. A scorer is defined in the customer's SDK; TraceRoot shows
 * ONLY what the SDK reported and what it observed from scores. Fields the SDK doesn't
 * register (type, capabilities, judge prompt/model, code refs, scope, description,
 * lifecycle) say "Not provided by SDK" rather than being invented from the name.
 */
function ScorerDetail({ projectId, scorer }: { projectId: string; scorer: ScorerRegistryRow }) {
  const maxCount = scorer.distribution?.reduce((m, d) => Math.max(m, d.count), 0) ?? 0;
  const family = useScorer(projectId, scorer.name);
  const versions = family.data?.versions ?? [];
  const categories =
    scorer.valueType === "categorical" && scorer.distribution
      ? scorer.distribution.map((d) => d.label)
      : null;

  return (
    <div className="flex flex-col">
      <div className="px-3 py-2.5">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <h2 className="text-[13px] font-medium">{scorer.name}</h2>
          <span className="text-[11px] text-muted-foreground">{scorer.version}</span>
          <Badge variant="outline" className="ml-auto">
            Defined in SDK
          </Badge>
        </div>
      </div>

      {/* 1 — What does it measure? */}
      <ScorerSection title="What does it measure?">
        <dl>
          <ScorerFact label="Output type">
            {VALUE_TYPE_LABEL[scorer.declaredValueType ?? scorer.valueType]}
            {scorer.declaredValueType === null && (
              <span className="ml-1 text-[11px] text-muted-foreground">(inferred)</span>
            )}
          </ScorerFact>
          <ScorerFact label="Direction">
            {scorer.direction ? DIRECTION_LABEL[scorer.direction] : <NotProvided />}
          </ScorerFact>
          <ScorerFact label="Threshold">
            {scorer.threshold !== null ? scorer.threshold : <NotProvided />}
          </ScorerFact>
          {categories && (
            <ScorerFact label="Categories (observed)">{categories.join(", ")}</ScorerFact>
          )}
          <ScorerFact label="Description">
            <NotProvided />
          </ScorerFact>
          <ScorerFact label="Scope / target">
            <NotProvided />
          </ScorerFact>
          <ScorerFact label="Expected output required">
            <NotProvided />
          </ScorerFact>
        </dl>
      </ScorerSection>

      {/* 2 — What does it read? */}
      <ScorerSection title="What does it read?">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The SDK does not yet report a scorer&apos;s declared capabilities (which of input,
          candidate output, expected output, metadata, tool calls or retrieval context it reads).{" "}
          <NotProvided />.
        </p>
      </ScorerSection>

      {/* 3 — How does it work? */}
      <ScorerSection title="How does it work?">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The scorer&apos;s type (rule, LLM judge or human) and its definition — a judge&apos;s
          rubric/prompt/model, or a code scorer&apos;s language/module/source reference — live in
          the SDK and are not registered with TraceRoot. <NotProvided />.
        </p>
      </ScorerSection>

      {/* 4 — Where is it used? */}
      <ScorerSection title="Where is it used?">
        <dl>
          <ScorerFact label="Evaluations">{scorer.evaluationCount}</ScorerFact>
          <ScorerFact label="Runs">{scorer.runCount}</ScorerFact>
          <ScorerFact label="Scored results">
            {scorer.scoreCount.toLocaleString("en-US")}
          </ScorerFact>
          {scorer.numeric && (
            <>
              <ScorerFact label="Mean">{scorer.numeric.mean.toFixed(3)}</ScorerFact>
              <ScorerFact label="Range">
                {scorer.numeric.min.toFixed(2)} – {scorer.numeric.max.toFixed(2)}
              </ScorerFact>
            </>
          )}
          {scorer.passRate !== null && (
            <ScorerFact label="Pass rate">{(scorer.passRate * 100).toFixed(1)}%</ScorerFact>
          )}
          <ScorerFact label="Error rate">
            {scorer.errorCount === 0 ? (
              <span className="text-muted-foreground">0%</span>
            ) : (
              <span className={SENTIMENT_CLASS.bad}>
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
          <div className="mt-2">
            <div className="mb-1 text-[11px] text-muted-foreground">Score distribution</div>
            <ul className="flex flex-col gap-1.5">
              {scorer.distribution.map((d) => (
                <li key={d.label} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 truncate" title={d.label}>
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
          <div className="mt-2">
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
          <div className="mt-2">
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
                    <span className="font-medium">{v.version}</span>
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
      </ScorerSection>

      <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        Source: SDK · Scorers are defined in your SDK code and can&apos;t be created or edited here.
      </div>
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
