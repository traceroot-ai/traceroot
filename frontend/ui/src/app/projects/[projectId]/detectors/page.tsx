"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core/llm-providers";
import { Button } from "@/components/ui/button";
import { ListState, ListLoading } from "@/components/ui/list-state";
import { Table, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { Timestamp } from "@/features/offline-eval/components";
import { buildUrlWithFilters } from "@/lib/utils";
import {
  useDetectorList,
  useDetectorCounts,
  useDeleteDetector,
} from "@/features/detectors/hooks/use-detectors";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { DETECTORS_DEFAULT_DATE_FILTER_ID } from "@/lib/date-filter";
import { useProject } from "@/features/projects/hooks";
import { useRetention } from "@/lib/hooks/use-retention";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import { PlanType } from "@traceroot/core";
import { DeleteDetectorDialog } from "@/features/detectors/components/delete-detector-dialog";
import { DetectorPanel } from "@/features/detectors/components/detector-panel";
import { getTemplate } from "@/features/detectors/templates";

function formatDetectorModel(detector: {
  detectionModel: string | null;
  detectionProvider: string | null;
  detectionSource: "system" | "byok" | null;
}) {
  if (detector.detectionModel) {
    return detector.detectionModel;
  }

  if (detector.detectionSource === "byok") {
    return detector.detectionProvider ?? "configured provider";
  }

  // Both "system" and a never-set null source resolve to the screening
  // default at eval time, so an unpinned detector reads the same either way.
  return DETECTOR_SYSTEM_DEFAULT_MODEL_ID;
}

export default function DetectorsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [actionsOpen, setActionsOpen] = useState<string | null>(null);
  const [selectedDetectorId, setSelectedDetectorId] = useState<string | null>(null);

  const { data: project } = useProject(projectId);
  const retention = useRetention(projectId);

  const {
    state,
    queryOptions,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
  } = useListPageState({
    defaultDateFilterId: DETECTORS_DEFAULT_DATE_FILTER_ID,
    retentionDays: retention.retentionDays,
  });

  // Carry the selected time range into the detail page so it stays consistent
  // across the list <-> detail navigation, mirroring how the Traces tabs
  // propagate the range via the URL. Arriving from the sidebar carries no
  // param, so the section resets to its default — the same as Traces.
  const buildUrl = (path: string) =>
    buildUrlWithFilters(path, {
      dateFilter: state.dateFilter,
      customStartDate: state.customStartDate,
      customEndDate: state.customEndDate,
    });

  const { data, isLoading, error, refetch } = useDetectorList(projectId, {
    page: queryOptions.page,
    limit: queryOptions.limit,
    search_query: queryOptions.search_query,
  });

  const {
    data: counts,
    isLoading: countsLoading,
    error: countsError,
  } = useDetectorCounts(projectId, {
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
          retentionDays={retention.retentionDays}
          onUpgradeClick={retention.onUpgradeClick}
        />

        {/* Table */}
        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <ListLoading label="Loading detectors..." />
          ) : error ? (
            <ListState
              icon={<AlertTriangle className="h-8 w-8 text-destructive/50" />}
              title="Error loading detectors"
              description="Make sure the API server is running and you have API keys configured."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[12px]"
                  onClick={() => refetch()}
                >
                  Try again
                </Button>
              }
            />
          ) : isEmptyProject ? (
            <ListState
              icon={<DOMAIN_ICONS.detector className="h-8 w-8 text-muted-foreground/40" />}
              title="No detectors yet"
              description="Create a detector to automatically analyze your traces."
              action={
                <Button
                  size="sm"
                  className="h-7 text-[12px]"
                  onClick={() => router.push(`/projects/${projectId}/detectors/new`)}
                >
                  New Detector
                </Button>
              }
            />
          ) : isEmptySearch ? (
            <ListState
              title={`No detectors match “${state.keyword}”`}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[12px]"
                  onClick={() => updateKeyword("")}
                >
                  Clear search
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TRHead>
                  <Th>Name</Th>
                  <Th>Template</Th>
                  <Th>Model</Th>
                  <Th>Sampling</Th>
                  <Th className="text-right">Findings</Th>
                  <Th className="text-right">Runs</Th>
                  <Th>Created At</Th>
                  <Th>Updated At</Th>
                  <Th>Detector ID</Th>
                  <Th className="w-[56px] text-right">Actions</Th>
                </TRHead>
              </THead>
              <TBody>
                {detectors.map((detector) => {
                  const template = getTemplate(detector.template);
                  const modelLabel = formatDetectorModel(detector);
                  const c = counts?.[detector.id];
                  const findingCount = c?.finding_count ?? 0;
                  const runCount = c?.run_count ?? 0;
                  return (
                    <TR
                      key={detector.id}
                      interactive
                      onClick={() =>
                        router.push(buildUrl(`/projects/${projectId}/detectors/${detector.id}`))
                      }
                    >
                      <Td className="text-foreground">{detector.name}</Td>
                      <Td className="text-muted-foreground">
                        {template?.label ?? detector.template}
                      </Td>
                      <Td className="text-muted-foreground">{modelLabel}</Td>
                      <Td className="text-muted-foreground">{detector.sampleRate}%</Td>
                      <Td className="text-right tabular-nums text-muted-foreground">
                        {countsLoading ? "—" : findingCount}
                      </Td>
                      <Td className="text-right tabular-nums text-muted-foreground">
                        {countsLoading ? "—" : runCount}
                      </Td>
                      <Td className="whitespace-nowrap text-muted-foreground">
                        <Timestamp iso={detector.createTime} />
                      </Td>
                      <Td className="whitespace-nowrap text-muted-foreground">
                        <Timestamp iso={detector.updateTime} />
                      </Td>
                      <Td
                        className="max-w-[240px] truncate font-mono text-[11px] text-muted-foreground"
                        title={detector.id}
                      >
                        {detector.id}
                      </Td>
                      <Td className="text-right">
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
                      </Td>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
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

      <PricingDialog
        open={retention.showPricing}
        onOpenChange={retention.closePricing}
        workspaceId={retention.workspaceId}
        currentPlan={(retention.billingPlan as PlanType) || PlanType.FREE}
      />
    </div>
  );
}
