"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, FlaskConical, ListChecks, Ruler } from "lucide-react";
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
  useEvaluations,
  useScorers,
  useDeleteRuns,
  type ScorerRegistryRow,
} from "../hooks";
import { EVAL_RUN_STATUS_LABEL, type EvalRunStatus } from "../types";
import { RunEvaluationDrawer } from "../components/run-evaluation-drawer";

type Tab = "runs" | "evaluations" | "scorers";

const TABS: Array<{ id: Tab; label: string; icon: typeof ListChecks }> = [
  { id: "runs", label: "Runs", icon: ListChecks },
  { id: "evaluations", label: "Evaluations", icon: FlaskConical },
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
  const router = useRouter();
  const [tab, setTab] = React.useState<Tab>("runs");
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
        {tab !== "scorers" && (
          <Button size="sm" className="h-7 text-[12px]" onClick={() => setRunOpen(true)}>
            Run evaluation
          </Button>
        )}
      </div>

      {tab === "runs" && <RunsTab projectId={projectId} />}
      {tab === "evaluations" && (
        <EvaluationsTab
          projectId={projectId}
          onOpenRun={(runId) => router.push(`/projects/${projectId}/evaluations/${runId}`)}
        />
      )}
      {tab === "scorers" && <ScorersTab projectId={projectId} />}

      <RunEvaluationDrawer projectId={projectId} open={runOpen} onOpenChange={setRunOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs — the flat execution list.
// ---------------------------------------------------------------------------

const RUNS_COLUMN_COUNT = 11;

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

function RunsTab({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [keyword, setKeyword] = React.useState("");
  const [datasetFilter, setDatasetFilter] = React.useState(ALL);
  const [statusFilter, setStatusFilter] = React.useState(ALL);
  const [dateFilter, setDateFilter] = React.useState<DateFilterOption>(
    DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0],
  );
  const [customStart, setCustomStart] = React.useState<Date | null>(null);
  const [customEnd, setCustomEnd] = React.useState<Date | null>(null);

  const { data: datasetsData } = useDatasets(projectId, { limit: 200 });
  const { data, isLoading, error } = useEvaluationRuns(projectId, {
    search_query: keyword.trim() || undefined,
    dataset_id: datasetFilter === ALL ? undefined : datasetFilter,
    status: statusFilter === ALL ? undefined : statusFilter,
  });
  const runs = React.useMemo(() => data?.data ?? [], [data]);
  const filtered = keyword || datasetFilter !== ALL || statusFilter !== ALL;

  // Row selection + bulk delete, matching the dataset cases table.
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

      <BulkActionBar count={sel.count} onDelete={deleteSelected} onClear={sel.clear} />

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <SelectAllHeaderCell
                checked={sel.allSelected}
                indeterminate={sel.someSelected}
                onToggle={sel.toggleAll}
              />
              <Th>Name</Th>
              <Th className="w-[140px]">Candidate version</Th>
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
                  {filtered
                    ? "No runs match these filters."
                    : "No evaluation runs yet. Use Run evaluation for the SDK snippet."}
                </EmptyState>
              </Cell>
            ) : (
              runs.map((r) => {
                const errors = r.errorCount;
                return (
                  <TR
                    key={r.id}
                    interactive
                    selected={sel.has(r.id)}
                    onClick={() => router.push(`/projects/${projectId}/evaluations/${r.id}`)}
                  >
                    <SelectRowCell
                      checked={sel.has(r.id)}
                      onToggle={() => sel.toggle(r.id)}
                      label={`Select ${r.evaluationName} #${r.runNumber}`}
                    />
                    <Td className="font-medium">
                      {r.evaluationName}
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        #{r.runNumber}
                      </span>
                    </Td>
                    <Td className="font-mono text-[11px]">{r.candidateVersion}</Td>
                    <Td className="text-muted-foreground">{r.datasetName}</Td>
                    <Td className="text-right tabular-nums">
                      {r.mainScore === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        pctFraction(r.mainScore)
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {r.changeFromBaseline === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={SENTIMENT_CLASS[changeSentiment(r.changeFromBaseline)]}>
                          {signedPoints(r.changeFromBaseline)} pp
                        </span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {/* Regressed TEST CASES (not score cells). "—" when there's no
                          trustworthy baseline to count against. */}
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
                      {errors === 0 ? <span className="text-muted-foreground">—</span> : errors}
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                      {formatElapsed(r.elapsedMs)}
                    </Td>
                    <Td className="whitespace-nowrap text-right text-muted-foreground">
                      <Timestamp iso={r.startedAt} />
                    </Td>
                  </TR>
                );
              })
            )}
          </TBody>
        </Table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Evaluations — one row per purpose (lineage), from the server.
// ---------------------------------------------------------------------------

// +1 for the leading selection checkbox column.
const SUITES_COLUMN_COUNT = 7;

function EvaluationsTab({
  projectId,
  onOpenRun,
}: {
  projectId: string;
  onOpenRun: (runId: string) => void;
}) {
  const { toast } = useToast();
  const [keyword, setKeyword] = React.useState("");
  const [dateFilter, setDateFilter] = React.useState<DateFilterOption>(
    DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0],
  );
  const [customStart, setCustomStart] = React.useState<Date | null>(null);
  const [customEnd, setCustomEnd] = React.useState<Date | null>(null);

  const { data, isLoading, error } = useEvaluations(projectId);
  const suites = React.useMemo(() => {
    const all = data?.data ?? [];
    const q = keyword.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.datasetName ?? "").toLowerCase().includes(q),
    );
  }, [data, keyword]);

  // Row selection, matching the Runs tab. There is no delete API for an evaluation
  // lineage, so the bar offers selection + Clear without a Delete action.
  const suiteIds = React.useMemo(() => suites.map((s) => s.id), [suites]);
  const sel = useRowSelection(suiteIds);

  return (
    <>
      <SearchFilterBar
        searchValue={keyword}
        onSearchChange={setKeyword}
        searchPlaceholder="Search evaluations..."
        dateFilter={dateFilter}
        customStartDate={customStart}
        customEndDate={customEnd}
        onDateFilterChange={setDateFilter}
        onCustomRangeChange={(s, e) => {
          setCustomStart(s);
          setCustomEnd(e);
        }}
      >
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
              <Th>Evaluation</Th>
              <Th>Dataset</Th>
              <Th className="w-[90px] text-right">Runs</Th>
              <Th className="w-[150px]">Latest candidate</Th>
              <Th className="w-[130px] text-right">Latest score</Th>
              <Th className="w-[130px] text-right">Last run</Th>
            </TRHead>
          </THead>
          <TBody>
            {isLoading ? (
              <Cell colSpan={SUITES_COLUMN_COUNT}>
                <EmptyState>Loading evaluations...</EmptyState>
              </Cell>
            ) : error ? (
              <Cell colSpan={SUITES_COLUMN_COUNT}>
                <EmptyState>Error loading evaluations</EmptyState>
              </Cell>
            ) : suites.length === 0 ? (
              <Cell colSpan={SUITES_COLUMN_COUNT}>
                <EmptyState>
                  {keyword ? "No evaluations match your search." : "No evaluations yet."}
                </EmptyState>
              </Cell>
            ) : (
              suites.map((suite) => (
                <TR
                  key={suite.id}
                  interactive
                  selected={sel.has(suite.id)}
                  onClick={() => suite.latestRun && onOpenRun(suite.latestRun.id)}
                >
                  <SelectRowCell
                    checked={sel.has(suite.id)}
                    onToggle={() => sel.toggle(suite.id)}
                    label={`Select ${suite.name}`}
                  />
                  <Td className="font-medium">
                    {suite.name}
                    <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">
                      {suite.id}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{suite.datasetName ?? "—"}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {suite.runCount}
                  </Td>
                  <Td className="font-mono text-[11px]">
                    {suite.latestRun?.candidateVersion ?? "—"}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {suite.latestRun?.mainScore == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      pctFraction(suite.latestRun.mainScore)
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right text-muted-foreground">
                    {suite.latestRun ? <Timestamp iso={suite.latestRun.startedAt} /> : "—"}
                  </Td>
                </TR>
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
                <Th className="w-[110px]">Type</Th>
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
          <ScorerDetail key={`${selected.name}@${selected.version}`} scorer={selected} />
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

/**
 * Scorer detail — everything TraceRoot has OBSERVED about a scorer (the SDK owns
 * its definition): value type + declared config, the score distribution, pass and
 * error rates with recent failures, and where it's used. All derived from the
 * scores it has reported.
 */
function ScorerDetail({ scorer }: { scorer: ScorerRegistryRow }) {
  const maxCount = scorer.distribution?.reduce((m, d) => Math.max(m, d.count), 0) ?? 0;

  return (
    <div className="flex flex-col">
      <div className="px-3 py-2.5">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <h2 className="text-[13px] font-medium">{scorer.name}</h2>
          <span className="text-[11px] text-muted-foreground">{scorer.version}</span>
          <Badge variant="outline" className="ml-auto">
            {VALUE_TYPE_LABEL[scorer.valueType]}
          </Badge>
        </div>
      </div>

      <ScorerSection title="Config">
        <dl>
          <ScorerFact label="Value type">
            {VALUE_TYPE_LABEL[scorer.declaredValueType ?? scorer.valueType]}
            {scorer.declaredValueType === null && (
              <span className="ml-1 text-[11px] text-muted-foreground">(inferred)</span>
            )}
          </ScorerFact>
          <ScorerFact label="Direction">
            {scorer.direction ? (
              DIRECTION_LABEL[scorer.direction]
            ) : (
              <span className="text-muted-foreground">Not declared</span>
            )}
          </ScorerFact>
          <ScorerFact label="Threshold">
            {scorer.threshold !== null ? (
              scorer.threshold
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </ScorerFact>
        </dl>
      </ScorerSection>

      <ScorerSection title="Scores">
        <dl>
          <ScorerFact label="Reported">{scorer.scoreCount.toLocaleString("en-US")}</ScorerFact>
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
        </dl>
      </ScorerSection>

      {scorer.distribution && scorer.distribution.length > 0 && (
        <ScorerSection title="Distribution">
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
        </ScorerSection>
      )}

      <ScorerSection title="Reliability">
        <dl>
          <ScorerFact label="Error rate">
            {scorer.errorCount === 0 ? (
              <span className="text-muted-foreground">0%</span>
            ) : (
              <span className={SENTIMENT_CLASS.bad}>
                {(scorer.errorRate * 100).toFixed(1)}% ({scorer.errorCount} of {scorer.scoreCount})
              </span>
            )}
          </ScorerFact>
        </dl>
        {scorer.recentErrors.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {scorer.recentErrors.map((e, i) => (
              <li
                key={i}
                className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
              >
                {e.message}
              </li>
            ))}
          </ul>
        )}
      </ScorerSection>

      <ScorerSection title="Usage">
        <dl>
          <ScorerFact label="Evaluations">{scorer.evaluationCount}</ScorerFact>
          <ScorerFact label="Runs">{scorer.runCount}</ScorerFact>
          <ScorerFact label="Last used">
            {scorer.lastUsed ? (
              <Timestamp iso={scorer.lastUsed} className="inline" />
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </ScorerFact>
        </dl>
      </ScorerSection>
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
