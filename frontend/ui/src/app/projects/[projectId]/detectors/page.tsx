"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Eye, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { formatDate, cn } from "@/lib/utils";
import {
  useDetectorList,
  useDetectorCounts,
  useDeleteDetector,
} from "@/features/detectors/hooks/use-detectors";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useProject } from "@/features/projects/hooks";
import { DeleteDetectorDialog } from "@/features/detectors/components/delete-detector-dialog";
import { DetectorPanel } from "@/features/detectors/components/detector-panel";
import { getTemplate } from "@/features/detectors/templates";

export default function DetectorsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [actionsOpen, setActionsOpen] = useState<string | null>(null);
  const [selectedDetectorId, setSelectedDetectorId] = useState<string | null>(null);

  const {
    state,
    queryOptions,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
  } = useListPageState({ defaultDateFilterId: "14d" });

  const { data: project } = useProject(projectId);

  const { data, isLoading, error } = useDetectorList(projectId, {
    page: queryOptions.page,
    limit: queryOptions.limit,
    search_query: queryOptions.search_query,
  });

  const { data: counts, isLoading: countsLoading } = useDetectorCounts(projectId, {
    start_after: queryOptions.start_after,
    end_before: queryOptions.end_before,
  });

  const deleteMutation = useDeleteDetector(projectId);
  const detectors = data?.data ?? [];
  const meta = data?.meta;

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        setDeleteTarget(null);
        if (selectedDetectorId === deleteTarget.id) setSelectedDetectorId(null);
      },
    });
  };

  const openPanel = (detectorId: string) => setSelectedDetectorId(detectorId);
  const closePanel = () => setSelectedDetectorId(null);

  const navigateDetector = (direction: "up" | "down") => {
    if (!selectedDetectorId) return;
    const idx = detectors.findIndex((d) => d.id === selectedDetectorId);
    if (idx === -1) return;
    const next = direction === "up" ? idx - 1 : idx + 1;
    if (next >= 0 && next < detectors.length) setSelectedDetectorId(detectors[next].id);
  };

  const isEmptyProject = !isLoading && !error && (meta?.total ?? 0) === 0 && !state.keyword;
  const isEmptySearch = !isLoading && !error && detectors.length === 0 && !!state.keyword;

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h1 className="text-[13px] font-medium">Detectors</h1>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => router.push(`/projects/${projectId}/detectors/new`)}
          >
            New Detector
          </Button>
        </div>

        {/* Search / time-range filter */}
        <SearchFilterBar
          searchValue={state.keyword}
          onSearchChange={updateKeyword}
          searchPlaceholder="Search..."
          dateFilter={state.dateFilter}
          customStartDate={state.customStartDate}
          customEndDate={state.customEndDate}
          onDateFilterChange={updateDateFilter}
          onCustomRangeChange={updateCustomRange}
        />

        {/* Table */}
        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-[13px] text-muted-foreground">Loading detectors...</p>
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading detectors</p>
            </div>
          ) : isEmptyProject ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <Eye className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-[13px] text-muted-foreground">No detectors yet</p>
              <p className="text-[12px] text-muted-foreground">
                Create a detector to automatically analyze your traces.
              </p>
              <Button
                size="sm"
                className="mt-1 h-7 text-[12px]"
                onClick={() => router.push(`/projects/${projectId}/detectors/new`)}
              >
                New Detector
              </Button>
            </div>
          ) : isEmptySearch ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-muted-foreground">
                No detectors match &ldquo;{state.keyword}&rdquo;
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[12px]"
                onClick={() => updateKeyword("")}
              >
                Clear search
              </Button>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                    Name
                  </th>
                  <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                    Template
                  </th>
                  <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                    Model
                  </th>
                  <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                    Sampling
                  </th>
                  <th className="border-r border-border/50 px-3 py-1.5 text-right text-[12px] font-medium text-muted-foreground">
                    Findings
                  </th>
                  <th className="border-r border-border/50 px-3 py-1.5 text-right text-[12px] font-medium text-muted-foreground">
                    Runs
                  </th>
                  <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                    Created At
                  </th>
                  <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                    Updated At
                  </th>
                  <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                    Detector ID
                  </th>
                  <th className="w-[56px] px-2 py-1.5 text-right text-[12px] font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {detectors.map((detector) => {
                  const template = getTemplate(detector.template);
                  const c = counts?.[detector.id];
                  const findingCount = c?.finding_count ?? 0;
                  const runCount = c?.run_count ?? 0;
                  const countClass =
                    "border-r border-border/50 px-3 py-1.5 text-right text-[12px] text-muted-foreground tabular-nums";
                  return (
                    <tr
                      key={detector.id}
                      onClick={() => router.push(`/projects/${projectId}/detectors/${detector.id}`)}
                      className={cn(
                        "cursor-pointer border-b border-border/50 transition-colors last:border-0",
                        selectedDetectorId === detector.id ? "bg-muted" : "hover:bg-muted/50",
                      )}
                    >
                      <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-foreground">
                        {detector.name}
                      </td>
                      <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                        {template?.label ?? detector.template}
                      </td>
                      <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                        {detector.detectionModel ?? "Default"}
                      </td>
                      <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                        {detector.sampleRate}%
                      </td>
                      <td className={countClass}>{countsLoading ? "—" : findingCount}</td>
                      <td className={countClass}>{countsLoading ? "—" : runCount}</td>
                      <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                        {formatDate(detector.createTime)}
                      </td>
                      <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                        {formatDate(detector.updateTime)}
                      </td>
                      <td className="border-r border-border/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {detector.id}
                      </td>
                      <td className="px-2 text-right">
                        <Popover
                          open={actionsOpen === detector.id}
                          onOpenChange={(open) => setActionsOpen(open ? detector.id : null)}
                        >
                          <PopoverTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-6 p-0 text-muted-foreground hover:text-foreground"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent align="end" className="w-36 p-1">
                            <button
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-muted/60"
                              onClick={(e) => {
                                e.stopPropagation();
                                openPanel(detector.id);
                                setActionsOpen(null);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                              Edit
                            </button>
                            <button
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-destructive hover:bg-destructive/10"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget({ id: detector.id, name: detector.name });
                                setActionsOpen(null);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </button>
                          </PopoverContent>
                        </Popover>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {meta && (
          <ListPagination
            page={meta.page}
            limit={meta.limit}
            total={meta.total}
            onPageChange={goToPage}
            onLimitChange={updateLimit}
          />
        )}
      </div>

      {/* Edit panel — fixed overlay */}
      {selectedDetectorId && (
        <DetectorPanel
          detectorId={selectedDetectorId}
          projectId={projectId}
          workspaceId={project?.workspace_id}
          onClose={closePanel}
          onNavigate={navigateDetector}
          canNavigateUp={detectors.findIndex((d) => d.id === selectedDetectorId) > 0}
          canNavigateDown={
            detectors.findIndex((d) => d.id === selectedDetectorId) < detectors.length - 1
          }
        />
      )}

      {deleteTarget && (
        <DeleteDetectorDialog
          detectorName={deleteTarget.name}
          isOpen={true}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
          isDeleting={deleteMutation.isPending}
        />
      )}
    </div>
  );
}
