"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { useUrlPagination } from "@/lib/hooks/use-url-pagination";
import { useToast } from "@/components/ui/toast";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { DatasetActionsMenu, Timestamp } from "@/features/offline-eval/components";
import { useDatasets, useDeleteDataset, useEvaluations } from "../hooks";
import type { DatasetRow } from "../types";
import { NewDatasetPanel, DatasetEditPanel } from "../components/dataset-panels";
import { DeleteDatasetDialog } from "../components/delete-dataset-dialog";

const TH =
  "h-7 whitespace-nowrap border-r border-border/50 px-3 text-left text-[12px] font-medium text-muted-foreground";
const TD = "border-r border-border/50 px-3 py-1.5 text-[12px]";

/**
 * Dataset list — the dataset library, wired to the server: tracing-style
 * search + date filter, a three-dot Edit/Delete menu, and right-side New/Edit
 * panels.
 */
export function DatasetsView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { toast } = useToast();

  const [keyword, setKeyword] = React.useState("");
  const [newOpen, setNewOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DatasetRow | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<DatasetRow | null>(null);

  const { page, limit, goToPage, setLimit } = useUrlPagination(50);
  const { data, isLoading, error, refetch } = useDatasets(projectId, {
    search_query: keyword.trim() || undefined,
    page,
    limit,
  });
  const datasets = React.useMemo(() => data?.data ?? [], [data]);
  const meta = data?.meta;
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

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const dataset = deleteTarget;
    del.mutate(dataset.id, {
      onSuccess: () => {
        toast({ title: `Deleted ${dataset.name}`, tone: "success" });
        setDeleteTarget(null);
      },
      onError: (e) => toast({ title: "Could not delete", description: String(e), tone: "warning" }),
    });
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

      {/* No date filter here: the list has no date predicate to apply one to
          (server-side search only), and a rendered-but-inert filter chip would
          falsely read as an applied constraint. */}
      <SearchFilterBar
        searchValue={keyword}
        onSearchChange={setKeyword}
        searchPlaceholder="Search datasets..."
      >
        <span className="flex-1" aria-hidden />
      </SearchFilterBar>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-border bg-muted/50">
              <th className={`${TH} w-[170px]`}>Last updated</th>
              <th className={`${TH} w-[240px]`}>Dataset ID</th>
              <th className={TH}>Name</th>
              <th className={`${TH} w-[110px] text-right`}>Test cases</th>
              <th className={`${TH} w-[90px] text-right`}>Versions</th>
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
              <RowMessage tone="destructive">
                Error loading datasets.{" "}
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="underline underline-offset-2"
                >
                  Try again
                </button>
              </RowMessage>
            ) : datasets.length === 0 ? (
              <RowMessage>
                {keyword
                  ? "No datasets match your search."
                  : "No datasets yet — save a trace or span as a test case to start one."}
              </RowMessage>
            ) : (
              datasets.map((dataset) => {
                const href = `/projects/${projectId}/datasets/${dataset.id}`;
                return (
                  <tr
                    key={dataset.id}
                    onClick={() => router.push(href)}
                    className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
                  >
                    <td className={`${TD} whitespace-nowrap text-muted-foreground`}>
                      <Timestamp iso={dataset.updateTime} />
                    </td>
                    <td
                      className={`${TD} max-w-[240px] truncate font-mono text-[11px] text-muted-foreground`}
                      title={dataset.id}
                    >
                      {dataset.id}
                    </td>
                    <td className={`${TD} font-medium`}>
                      {/* A real link, not just a clickable <tr>: keyboard-reachable,
                          and middle-click / open-in-new-tab / copy-link all work.
                          The row's onClick above stays as a mouse convenience. */}
                      <Link
                        href={href}
                        className="rounded outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {dataset.name}
                      </Link>
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>{dataset.caseCount}</td>
                    <td className={`${TD} text-right tabular-nums text-muted-foreground`}>
                      {dataset.versionCount}
                    </td>
                    <td className={`${TD} text-right tabular-nums text-muted-foreground`}>
                      {evalCountByDataset.get(dataset.id) ?? 0}
                    </td>
                    <td className="px-2 text-right">
                      <DatasetActionsMenu
                        onEdit={() => setEditing(dataset)}
                        onDelete={() => setDeleteTarget(dataset)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {meta && meta.total > 0 && (
        <ListPagination
          page={meta.page}
          limit={meta.limit}
          total={meta.total}
          onPageChange={goToPage}
          onLimitChange={setLimit}
        />
      )}

      <NewDatasetPanel projectId={projectId} open={newOpen} onOpenChange={setNewOpen} />
      {editing && (
        <DatasetEditPanel
          projectId={projectId}
          dataset={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleteTarget && (
        <DeleteDatasetDialog
          datasetName={deleteTarget.name}
          caseCount={deleteTarget.caseCount}
          isOpen
          onClose={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
          isDeleting={del.isPending}
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
