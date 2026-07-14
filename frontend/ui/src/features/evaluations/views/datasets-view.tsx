"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { DATE_FILTER_OPTIONS, type DateFilterOption } from "@/lib/date-filter";
import { useToast } from "@/components/ui/toast";
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  DatasetActionsMenu,
  SelectAllHeaderCell,
  SelectRowCell,
  Timestamp,
  useRowSelection,
} from "@/features/offline-eval/components";
import { useDatasets, useDeleteDataset, useEvaluations } from "../hooks";
import type { DatasetRow } from "../types";
import { NewDatasetPanel, DatasetEditPanel } from "../components/dataset-panels";

const DEFAULT_DATE_FILTER =
  DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0];

const TH =
  "h-7 whitespace-nowrap border-r border-border/50 px-3 text-left text-[12px] font-medium text-muted-foreground";
const TD = "border-r border-border/50 px-3 py-1.5 text-[12px]";

/**
 * Dataset list — the dataset library, wired to the server: tracing-style
 * search + date filter, row
 * selection with "N selected · Delete" beside the search, a three-dot
 * Edit/Delete menu, and right-side New/Edit panels.
 */
export function DatasetsView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { toast } = useToast();

  const [keyword, setKeyword] = React.useState("");
  const [dateFilter, setDateFilter] = React.useState<DateFilterOption>(DEFAULT_DATE_FILTER);
  const [customStart, setCustomStart] = React.useState<Date | null>(null);
  const [customEnd, setCustomEnd] = React.useState<Date | null>(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DatasetRow | null>(null);

  const { data, isLoading, error } = useDatasets(projectId, {
    search_query: keyword.trim() || undefined,
  });
  const datasets = React.useMemo(() => data?.data ?? [], [data]);
  const del = useDeleteDataset(projectId);

  // Evaluations-per-dataset comes from the lineage list (one row per evaluation
  // purpose, each carrying its datasetId); the dataset row itself has no count.
  const { data: evaluationsData } = useEvaluations(projectId);
  const evalCountByDataset = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const e of evaluationsData?.data ?? []) {
      map.set(e.datasetId, (map.get(e.datasetId) ?? 0) + 1);
    }
    return map;
  }, [evaluationsData]);

  const ids = React.useMemo(() => datasets.map((d) => d.id), [datasets]);
  const sel = useRowSelection(ids);

  const deleteOne = (dataset: DatasetRow) => {
    del.mutate(dataset.id, {
      onSuccess: () => toast({ title: `Deleted ${dataset.name}`, tone: "success" }),
      onError: (e) => toast({ title: "Could not delete", description: String(e), tone: "warning" }),
    });
  };

  const deleteSelected = () => {
    const chosen = [...sel.selected];
    if (chosen.length === 0) return;
    Promise.all(chosen.map((id) => del.mutateAsync(id)))
      .then(() => toast({ title: `${chosen.length} deleted`, tone: "success" }))
      .catch((e) => toast({ title: "Could not delete", description: String(e), tone: "warning" }));
    sel.clear();
  };

  return (
    <div className="flex h-full flex-col text-[13px]">
      {/* Populates the app's top breadcrumb bar (workspace / project). Without a
          mounted ProjectBreadcrumb the header goes blank on this route. */}
      <ProjectBreadcrumb projectId={projectId} current="Datasets" />
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h1 className="text-[13px] font-medium">Datasets</h1>
        <Button size="sm" className="h-7 text-[12px]" onClick={() => setNewOpen(true)}>
          New Dataset
        </Button>
      </div>

      <SearchFilterBar
        searchValue={keyword}
        onSearchChange={setKeyword}
        searchPlaceholder="Search datasets..."
        dateFilter={dateFilter}
        customStartDate={customStart}
        customEndDate={customEnd}
        onDateFilterChange={setDateFilter}
        onCustomRangeChange={(s, e) => {
          setCustomStart(s);
          setCustomEnd(e);
        }}
      >
        {sel.count > 0 && (
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={sel.clear}
              aria-label="Cancel selection"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span className="text-[12px] font-medium tabular-nums">{sel.count} selected</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-1.5 text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={deleteSelected}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
          </span>
        )}
        <span className="flex-1" aria-hidden />
      </SearchFilterBar>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-border bg-muted/50">
              <SelectAllHeaderCell
                checked={sel.allSelected}
                indeterminate={sel.someSelected}
                onToggle={sel.toggleAll}
              />
              <th className={`${TH} w-[170px]`}>Last updated</th>
              <th className={`${TH} w-[240px]`}>Dataset ID</th>
              <th className={TH}>Name</th>
              <th className={`${TH} w-[110px] text-right`}>Test cases</th>
              <th className={`${TH} w-[110px] text-right`}>Evaluations</th>
              <th className="w-[56px] px-2 py-1.5 text-right text-[12px] font-medium text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <RowMessage>Loading datasets...</RowMessage>
            ) : error ? (
              <RowMessage tone="destructive">Error loading datasets</RowMessage>
            ) : datasets.length === 0 ? (
              <RowMessage>
                {keyword
                  ? "No datasets match your search."
                  : "No datasets yet — save a trace or span as a test case to start one."}
              </RowMessage>
            ) : (
              datasets.map((dataset) => (
                <tr
                  key={dataset.id}
                  onClick={() => router.push(`/projects/${projectId}/datasets/${dataset.id}`)}
                  className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
                >
                  <SelectRowCell
                    checked={sel.has(dataset.id)}
                    onToggle={() => sel.toggle(dataset.id)}
                    label={`Select ${dataset.name}`}
                  />
                  <td className={`${TD} whitespace-nowrap text-muted-foreground`}>
                    <Timestamp iso={dataset.updateTime} />
                  </td>
                  <td
                    className={`${TD} max-w-[240px] truncate font-mono text-[11px] text-muted-foreground`}
                    title={dataset.id}
                  >
                    {dataset.id}
                  </td>
                  <td className={`${TD} font-medium`}>{dataset.name}</td>
                  <td className={`${TD} text-right tabular-nums`}>{dataset.caseCount}</td>
                  <td className={`${TD} text-right tabular-nums text-muted-foreground`}>
                    {evalCountByDataset.get(dataset.id) || "—"}
                  </td>
                  <td className="px-2 text-right">
                    <DatasetActionsMenu
                      onEdit={() => setEditing(dataset)}
                      onDelete={() => deleteOne(dataset)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <NewDatasetPanel projectId={projectId} open={newOpen} onOpenChange={setNewOpen} />
      {editing && (
        <DatasetEditPanel
          projectId={projectId}
          dataset={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RowMessage({ children, tone }: { children: React.ReactNode; tone?: "destructive" }) {
  return (
    <tr>
      <td
        colSpan={7}
        className={`px-3 py-10 text-center text-[12px] ${
          tone ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {children}
      </td>
    </tr>
  );
}
