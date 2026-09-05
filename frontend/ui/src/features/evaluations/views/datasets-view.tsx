"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useToast } from "@/components/ui/toast";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { DatasetActionsMenu, Timestamp } from "@/features/offline-eval/components";
import { Table, TBody, Td, Th, THead, TR, TRHead, TableEmpty } from "@/components/ui/table";
import { useDatasets, useDeleteDataset, useEvaluations } from "../hooks";
import type { DatasetRow } from "../types";
import { NewDatasetPanel, DatasetEditPanel } from "../components/dataset-panels";
import { DeleteDatasetDialog } from "../components/delete-dataset-dialog";

/**
 * Dataset list — the dataset library, wired to the server: tracing-style
 * search + date filter, a three-dot Edit/Delete menu, and right-side New/Edit
 * panels.
 */
export function DatasetsView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { toast } = useToast();

  const {
    page,
    limit,
    goToPage,
    updateLimit,
    keyword,
    updateKeyword,
    queryOptions,
    resetPageState,
  } = useListPageState({ defaultLimit: 50 });
  const [newOpen, setNewOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DatasetRow | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<DatasetRow | null>(null);

  const { data, isLoading, error, refetch } = useDatasets(projectId, {
    search_query: queryOptions.search_query,
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
        resetPageState();
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
        onSearchChange={updateKeyword}
        searchPlaceholder="Search..."
      >
        <span className="flex-1" aria-hidden />
      </SearchFilterBar>

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <THead>
            <TRHead>
              <Th className="w-[170px]">Updated At</Th>
              <Th>Name</Th>
              <Th className="w-[240px]">Dataset ID</Th>
              <Th className="w-[110px] text-right">Items</Th>
              <Th className="w-[90px] text-right">Versions</Th>
              <Th className="w-[110px] text-right">Evaluations</Th>
              <Th className="w-[56px] text-right">Actions</Th>
            </TRHead>
          </THead>
          <TBody>
            {isLoading ? (
              <TableEmpty colSpan={7}>Loading datasets...</TableEmpty>
            ) : error ? (
              <TableEmpty colSpan={7}>
                Error loading datasets.{" "}
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="underline underline-offset-2"
                >
                  Try again
                </button>
              </TableEmpty>
            ) : datasets.length === 0 ? (
              <TableEmpty colSpan={7}>
                {keyword
                  ? "No datasets match your search."
                  : "No datasets yet — save a trace or span as a test case to start one."}
              </TableEmpty>
            ) : (
              datasets.map((dataset) => {
                const href = `/projects/${projectId}/datasets/${dataset.id}`;
                return (
                  <TR key={dataset.id} interactive onClick={() => router.push(href)}>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      <Timestamp iso={dataset.updateTime} />
                    </Td>
                    {/* Name is the row's primary identifier — dark like the detector
                        list's name cell — but NOT a separate link: the whole row is the
                        single click target (keyboard-reachable via the interactive TR),
                        so there's no competing name link. */}
                    <Td className="text-foreground">{dataset.name}</Td>
                    <Td
                      className="max-w-[240px] truncate font-mono text-[11px] text-muted-foreground"
                      title={dataset.clientDatasetId ?? dataset.id}
                    >
                      {dataset.clientDatasetId ?? dataset.id}
                    </Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {dataset.caseCount}
                    </Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {dataset.versionCount}
                    </Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {evalCountByDataset.get(dataset.id) ?? 0}
                    </Td>
                    <Td className="text-right">
                      <DatasetActionsMenu
                        onEdit={() => setEditing(dataset)}
                        onDelete={() => setDeleteTarget(dataset)}
                      />
                    </Td>
                  </TR>
                );
              })
            )}
          </TBody>
        </Table>
      </div>

      {meta && meta.total > 0 && (
        <ListPagination
          page={page}
          limit={limit}
          total={meta.total}
          onPageChange={goToPage}
          onLimitChange={updateLimit}
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
