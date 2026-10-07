"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { DateFilterSelect } from "@/components/date-filter-select";
import { DATE_FILTER_OPTIONS, toTimestampBounds, type DateFilterOption } from "@/lib/date-filter";
import { useKeywordSearch } from "@/lib/hooks/use-keyword-search";
import { useUrlPagination } from "@/lib/hooks/use-url-pagination";
import { useRememberListQuery } from "@/lib/hooks/use-list-return";
import { Table, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";
import { DatasetActionsMenu, EmptyState, Timestamp } from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useEvaluationRuns, useDeleteRuns } from "../hooks";
import { DeleteRunDialog } from "../components/delete-run-dialog";
import { EVAL_RUN_STATUS_LABEL, type EvalRunStatus, type RunRow } from "../types";

// The Evaluations page is one flat table of immutable runs. Scorers live in the
// SDK (tracked server-side, no UI page); per-run pass/fail and "main score" are
// intentionally not surfaced here — a run has many scores and it's the author's
// call what "passing" means, so the list stays to identity, cost, and lifecycle.

const STATUS_VARIANT: Record<EvalRunStatus, "success" | "danger" | "warning" | "default"> = {
  running: "default",
  completed: "success",
  completed_with_errors: "warning",
  failed: "danger",
  incomplete: "warning",
  cancelled: "default",
};

export function RunStatusBadge({ status }: { status: EvalRunStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{EVAL_RUN_STATUS_LABEL[status]}</Badge>;
}

const RUNS_COLUMN_COUNT = 10;
// Matches the route's default `limit` (runs/route.ts) so the page-count math lines
// up with what the server actually returns per page.
const RUNS_PAGE_LIMIT = 50;
const DEFAULT_RUNS_DATE_FILTER =
  DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0];

/** Parses an ISO `?start=` / `?end=` param; null when absent or not a date. */
function parseUrlDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

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

/** Total run cost; "—" when no case reported a cost (never a misleading $0). */
export function formatCost(cost: number | null | undefined): React.ReactNode {
  if (cost === null || cost === undefined) return <span className="text-muted-foreground">—</span>;
  return `$${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

export function EvaluationsView({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full flex-col text-[13px]">
      {/* Populates the app's top breadcrumb bar (workspace / project). Without a
          mounted ProjectBreadcrumb the header goes blank on this route. */}
      <ProjectBreadcrumb projectId={projectId} current="Evaluations" />
      <RunsTab projectId={projectId} />
    </div>
  );
}

/**
 * One immutable run row: experiment (lineage) name, the run's own name (candidate
 * version + run number), the dataset (name + version snowflake, linking to the
 * dataset), and total/average cost and duration. Clicking the row opens the run
 * detail; the far-right menu deletes the run.
 */
function RunTableRow({
  run: r,
  projectId,
  onDelete,
  selected,
  onToggleSelect,
}: {
  run: RunRow;
  projectId: string;
  onDelete: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const router = useRouter();
  // Total ÷ case count. elapsedMs here is the SUM of per-case durations (see the
  // runs route), so avg duration is a true average case latency.
  const avgCost = r.cost != null && r.caseCount > 0 ? r.cost / r.caseCount : null;
  const avgDurationMs =
    r.elapsedMs != null && r.caseCount > 0 ? Math.round(r.elapsedMs / r.caseCount) : null;
  // The pinned dataset-version id — the time-sortable snowflake, stored as the id.
  const datasetVersion = r.datasetVersionId || null;
  return (
    <TR interactive onClick={() => router.push(`/projects/${projectId}/evaluations/${r.id}`)}>
      {/* Selection — clicking the checkbox must not open the run detail. */}
      <Td className="w-[36px]" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          aria-label={`Select run ${r.candidateVersion} #${r.runNumber}`}
        />
      </Td>
      <Td className="whitespace-nowrap text-muted-foreground">
        <Timestamp iso={r.startedAt} />
      </Td>
      {/* Experiment name is the row's primary identifier — dark, plain text (the
          whole row is the single click target → the run detail). */}
      <Td className="text-foreground">{r.evaluationName}</Td>
      <Td className="whitespace-nowrap">
        <span className="font-mono">{r.candidateVersion}</span>{" "}
        <span className="tabular-nums text-muted-foreground">#{r.runNumber}</span>
      </Td>
      <Td className="text-muted-foreground">
        {/* Dataset name links to the dataset; stop the click from also opening the
            run detail (the row's own onClick). The version snowflake sits beside it. */}
        <Link
          href={`/projects/${projectId}/datasets/${r.datasetId}`}
          onClick={(e) => e.stopPropagation()}
          className="text-foreground hover:underline"
        >
          {r.datasetName}
        </Link>{" "}
        {datasetVersion && <span className="font-mono text-[11px]">{datasetVersion}</span>}
      </Td>
      <Td className="text-right tabular-nums text-muted-foreground">{formatCost(r.cost)}</Td>
      <Td className="text-right tabular-nums text-muted-foreground">{formatCost(avgCost)}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
        {formatElapsed(r.elapsedMs)}
      </Td>
      <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
        {formatElapsed(avgDurationMs)}
      </Td>
      <Td className="text-right">
        <DatasetActionsMenu onDelete={onDelete} />
      </Td>
    </TR>
  );
}

function RunsTab({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const del = useDeleteRuns(projectId);
  const [deleteRun, setDeleteRun] = React.useState<RunRow | null>(null);
  // Row selection for bulk actions (compare / delete).
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  // The page and the date window live in the URL (`?page_index=`, `?date_filter=`,
  // `?start=`/`?end=`) so opening a run and coming back lands on the same page of
  // the same result set instead of the first page of the default window.
  const { page, goToPage, resetPage, resetPageState } = useUrlPagination(RUNS_PAGE_LIMIT);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const listQuery = searchParams.toString();
  useRememberListQuery(`evaluations:${projectId}`, listQuery);
  const urlDateFilterId = searchParams.get("date_filter");
  const urlStart = searchParams.get("start");
  const urlEnd = searchParams.get("end");
  // Memoized on the raw params so the Date identities (and the bounds below) are stable.
  const customStart = React.useMemo(() => parseUrlDate(urlStart), [urlStart]);
  const customEnd = React.useMemo(() => parseUrlDate(urlEnd), [urlEnd]);
  // A custom window needs both bounds, in order; a hand-edited or truncated URL
  // without them falls back to the default window rather than querying unbounded.
  const dateFilter = React.useMemo(() => {
    const option = DATE_FILTER_OPTIONS.find((o) => o.id === urlDateFilterId);
    if (!option) return DEFAULT_RUNS_DATE_FILTER;
    if (option.isCustom && !(customStart && customEnd && customStart <= customEnd)) {
      return DEFAULT_RUNS_DATE_FILTER;
    }
    return option;
  }, [urlDateFilterId, customStart, customEnd]);
  // A narrower filter/date-range can otherwise land on a page past the end of its
  // (now shorter) result set, so reset to the first page whenever ANY server query
  // input changes — the search text OR the date window. Done from the change itself,
  // not an effect on the inputs: an effect would also fire on mount and throw away
  // the page restored from the URL.
  const { keyword, setKeyword, searchQuery } = useKeywordSearch(resetPage);
  // One URL write per date change that also drops `page_index`; a separate page-reset
  // write would rebuild from the stale params and lose the new window.
  const writeDateWindow = (id: string, start: Date | null, end: Date | null) => {
    const params = new URLSearchParams(listQuery);
    if (id === DEFAULT_RUNS_DATE_FILTER.id) params.delete("date_filter");
    else params.set("date_filter", id);
    if (start && end) {
      params.set("start", start.toISOString());
      params.set("end", end.toISOString());
    } else {
      params.delete("start");
      params.delete("end");
    }
    params.delete("page_index");
    resetPageState();
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  // Picking "Custom" is always followed by `setCustomRange` with the chosen bounds,
  // which does the single URL write; writing here too would briefly drop the bounds.
  const setDateFilter = (option: DateFilterOption) => {
    if (!option.isCustom) writeDateWindow(option.id, null, null);
  };
  const setCustomRange = (start: Date, end: Date) => writeDateWindow("custom", start, end);

  // Resolve the selected range to actual bounds. Memoized on the filter/custom-range
  // inputs: `toTimestampBounds` reads `new Date()` for preset windows, so recomputing
  // every render would churn the query key and refetch forever.
  const { startAfter, endBefore } = React.useMemo(
    () => toTimestampBounds(dateFilter.id, customStart ?? undefined, customEnd ?? undefined),
    [dateFilter.id, customStart, customEnd],
  );
  const { data, isLoading, isPlaceholderData, error } = useEvaluationRuns(projectId, {
    search_query: searchQuery,
    started_after: startAfter,
    started_before: endBefore,
    page,
    limit: RUNS_PAGE_LIMIT,
  });
  const runs = React.useMemo(() => data?.data ?? [], [data]);
  // Keyed off the immediate `keyword`, not the debounced `searchQuery`, so the
  // empty-state copy doesn't flicker for the 300ms before the debounce catches up.
  const filtered = !!keyword;
  const total = data?.meta?.total ?? runs.length;

  // After a delete shrinks the result set, the current page can point past the new
  // end (empty table + invalid "showing X–Y of N" range). Clamp back to the last
  // page that still has rows. Skipped while placeholder rows from the previous query
  // are shown: their total belongs to a different query and would clamp a valid page.
  React.useEffect(() => {
    if (isLoading || isPlaceholderData || total === 0) return;
    const lastPage = Math.max(0, Math.ceil(total / RUNS_PAGE_LIMIT) - 1);
    if (page > lastPage) goToPage(lastPage);
  }, [total, page, isLoading, isPlaceholderData, goToPage]);

  const confirmDelete = () => {
    if (!deleteRun) return;
    del.mutate([deleteRun.id], {
      onSuccess: () => {
        toast({ title: "Run deleted", tone: "success" });
        setDeleteRun(null);
      },
      onError: (e) =>
        toast({ title: "Could not delete the run", description: String(e), tone: "warning" }),
    });
  };

  // Selection is per-page (checkboxes only exist for loaded rows); clear it when the
  // page OR any query input (search / date window) changes, so a now-hidden id can't
  // ride along into a bulk delete of a different result set.
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [page, searchQuery, dateFilter.id, customStart, customEnd]);

  const allSelected = runs.length > 0 && runs.every((r) => selectedIds.has(r.id));
  const toggleSelect = (id: string) =>
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(runs.map((r) => r.id)));

  // Compare two OR MORE runs on the shareable /evaluations/compare view. The oldest
  // (lowest run number) seeds the baseline; the page lets you re-pick it.
  const compareSelected = () => {
    const chosen = runs
      .filter((r) => selectedIds.has(r.id))
      .sort((a, b) => a.runNumber - b.runNumber);
    if (chosen.length < 2) return;
    // Rows line up by dataset-row id, which only means something within ONE dataset
    // (versions may differ). Refuse a cross-dataset selection here — before leaving the
    // page — rather than landing on an empty comparison.
    if (new Set(chosen.map((r) => r.datasetName ?? r.datasetId)).size > 1) {
      toast({
        title: "Pick runs from the same dataset",
        description: "Runs can only be compared within a single dataset.",
        tone: "warning",
      });
      return;
    }
    const ids = chosen.map((r) => r.id).join(",");
    router.push(`/projects/${projectId}/evaluations/compare?runs=${ids}&baseline=${chosen[0].id}`);
  };
  const confirmBulkDelete = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    del.mutate(ids, {
      onSuccess: () => {
        toast({
          title: `Deleted ${ids.length} run${ids.length === 1 ? "" : "s"}`,
          tone: "success",
        });
        setSelectedIds(new Set());
        setBulkDeleteOpen(false);
      },
      onError: (e) =>
        toast({ title: "Could not delete the runs", description: String(e), tone: "warning" }),
    });
  };

  return (
    <>
      <SearchFilterBar
        searchValue={keyword}
        onSearchChange={setKeyword}
        searchPlaceholder="Search..."
      >
        {/* The bulk-Actions button and the date filter form one right-aligned group
            (a single `ml-auto`), so Actions sits immediately left of the date range
            selector rather than floating in the middle. The date filter is rendered
            here (not via SearchFilterBar's own `dateFilter` prop) precisely so the two
            share one auto-margin instead of splitting the free space between two. */}
        <div className="ml-auto flex items-center gap-x-3">
          {selectedIds.size > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="h-7 gap-1.5 text-[12px]">
                  Actions ({selectedIds.size} selected)
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                <DropdownMenuItem
                  disabled={selectedIds.size < 2}
                  onSelect={compareSelected}
                  className="text-[12px]"
                >
                  Compare
                  {selectedIds.size < 2 && (
                    <span className="ml-auto text-[10px] text-muted-foreground">pick 2+</span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setBulkDeleteOpen(true)}
                  className="text-[12px] text-destructive"
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DateFilterSelect
            dateFilter={dateFilter}
            customStartDate={customStart}
            customEndDate={customEnd}
            onDateFilterChange={setDateFilter}
            onCustomRangeChange={setCustomRange}
          />
        </div>
      </SearchFilterBar>

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <Th className="w-[36px]">
                <Checkbox
                  checked={allSelected}
                  indeterminate={selectedIds.size > 0 && !allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all runs"
                />
              </Th>
              <Th className="w-[150px]">Timestamp</Th>
              <Th>Evaluation Name</Th>
              <Th>Run Name</Th>
              <Th>Dataset</Th>
              <Th className="w-[100px] text-right">Cost</Th>
              <Th className="w-[100px] text-right">Avg Cost</Th>
              <Th className="w-[90px] text-right">Duration</Th>
              <Th className="w-[100px] text-right">Avg Duration</Th>
              <Th className="w-[70px] text-right">Actions</Th>
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
                    : "No evaluation runs yet. Report a run from your SDK and it appears here."}
                </EmptyState>
              </Cell>
            ) : (
              runs.map((r) => (
                <RunTableRow
                  key={r.id}
                  run={r}
                  projectId={projectId}
                  onDelete={() => setDeleteRun(r)}
                  selected={selectedIds.has(r.id)}
                  onToggleSelect={() => toggleSelect(r.id)}
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
              onClick={() => goToPage(Math.max(0, page - 1))}
              disabled={page === 0}
              aria-label="Previous page"
              className="rounded p-1 hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={(page + 1) * RUNS_PAGE_LIMIT >= total}
              aria-label="Next page"
              className="rounded p-1 hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {deleteRun && (
        <DeleteRunDialog
          runLabel={`${deleteRun.candidateVersion} #${deleteRun.runNumber}`}
          isOpen
          onClose={() => setDeleteRun(null)}
          onConfirm={confirmDelete}
          isDeleting={del.isPending}
        />
      )}

      {bulkDeleteOpen && (
        <DeleteRunDialog
          runLabel={`${selectedIds.size} selected run${selectedIds.size === 1 ? "" : "s"}`}
          isOpen
          onClose={() => setBulkDeleteOpen(false)}
          onConfirm={confirmBulkDelete}
          isDeleting={del.isPending}
        />
      )}
    </>
  );
}

function Cell({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan}>{children}</td>
    </tr>
  );
}
