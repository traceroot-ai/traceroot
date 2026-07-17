"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ListChecks, Ruler } from "lucide-react";
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
// Runs — the flat execution list.
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
 * One immutable run row. Clicking the evaluation name scopes the list to that
 * lineage (?evaluation=<id>).
 */
function RunTableRow({ run: r, projectId }: { run: RunRow; projectId: string }) {
  const router = useRouter();
  return (
    <TR interactive onClick={() => router.push(`/projects/${projectId}/evaluations/${r.id}`)}>
      <Td>
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

  const { data: datasetsData } = useDatasets(projectId, { limit: 200 });
  const { data, isLoading, error } = useEvaluationRuns(projectId, {
    evaluation_id: scopedEvalId ?? undefined,
    search_query: keyword.trim() || undefined,
    dataset_id: datasetFilter === ALL ? undefined : datasetFilter,
    status: statusFilter === ALL ? undefined : statusFilter,
  });
  const runs = React.useMemo(() => data?.data ?? [], [data]);
  const filtered = !!keyword || datasetFilter !== ALL || statusFilter !== ALL;

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
      </SearchFilterBar>

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
