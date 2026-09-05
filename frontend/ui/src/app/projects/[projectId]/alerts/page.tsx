"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { ListPagination } from "@/components/list-pagination";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useProject } from "@/features/projects/hooks";
import { AlertsOnboarding } from "@/features/alerts/components/alerts-onboarding";
import { AlertsCapacityNotice } from "@/features/alerts/components/alerts-capacity-notice";
import { AlertsTable } from "@/features/alerts/components/alerts-table";
import { DeleteAlertDialog } from "@/features/alerts/components/delete-alert-dialog";
import { isAlertCapacityLow, isAtAlertCapacity } from "@/features/alerts/capacity";
import {
  useAlertCapacity,
  useAlertList,
  useDeleteAlert,
  useSetAlertStatus,
  type AlertSummary,
} from "@/features/alerts/hooks/use-alerts";
import { useListPageState } from "@/lib/hooks/use-list-page-state";

export default function AlertsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const { state, queryOptions, updateKeyword, updateLimit, goToPage } = useListPageState();

  const { data, isLoading, error } = useAlertList(projectId, {
    page: queryOptions.page,
    limit: queryOptions.limit,
    search_query: queryOptions.search_query,
  });

  const { data: capacity } = useAlertCapacity(projectId);
  const { data: project } = useProject(projectId);

  const deleteMutation = useDeleteAlert(projectId);
  const statusMutation = useSetAlertStatus(projectId);

  const alerts = data?.data ?? [];
  const meta = data?.meta;

  const isEmptyProject = !isLoading && !error && (meta?.total ?? 0) === 0 && !state.keyword;
  const isEmptySearch = !isLoading && !error && alerts.length === 0 && !!state.keyword;
  // The onboarding splash is the whole page for a project with no alerts, so
  // the search bar and the header action stay out of its way.
  const showListChrome = !isLoading && !error && !isEmptyProject;

  // Off anything that is not running, on anything that is: a parked rule's
  // action is to start it, not to pause a rule already stopped.
  const handleToggleStatus = (alert: AlertSummary) => {
    statusMutation.mutate({
      alertId: alert.id,
      status: alert.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) });
  };

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h1 className="text-[13px] font-medium">Alerts</h1>
          {showListChrome && (
            <div className="flex items-center gap-3">
              {capacity && isAlertCapacityLow(capacity) && (
                <span className="text-[12px] text-muted-foreground">
                  {capacity.used} of {capacity.max} alerts used
                </span>
              )}
              <Button
                size="sm"
                className="h-7 text-[12px]"
                disabled={isAtAlertCapacity(capacity)}
                onClick={() => router.push(`/projects/${projectId}/alerts/new`)}
              >
                New Alert
              </Button>
            </div>
          )}
        </div>

        {/* No date filter: an alert is configuration, and the list endpoint
            takes no time range. */}
        {showListChrome && (
          <SearchFilterBar searchValue={state.keyword} onSearchChange={updateKeyword} />
        )}

        {showListChrome && (
          <AlertsCapacityNotice
            capacity={capacity}
            className="border-b border-border bg-muted/50 px-4 py-2 text-muted-foreground"
          />
        )}

        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label="Loading alerts..." />
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading alerts</p>
              <p className="max-w-md text-center text-[12px] text-muted-foreground">
                {error instanceof Error ? error.message : String(error)}
              </p>
            </div>
          ) : isEmptyProject ? (
            <AlertsOnboarding projectId={projectId} />
          ) : isEmptySearch ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-muted-foreground">
                No alerts match &ldquo;{state.keyword}&rdquo;
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
            <>
              {statusMutation.error && (
                <p className="border-b border-border px-4 py-2 text-[12px] text-destructive">
                  {statusMutation.error.message}
                </p>
              )}
              <AlertsTable
                alerts={alerts}
                projectId={projectId}
                workspaceId={project?.workspace_id}
                onToggleStatus={handleToggleStatus}
                onDelete={(alert) => setDeleteTarget({ id: alert.id, name: alert.name })}
                isStatusPending={statusMutation.isPending}
              />
            </>
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

      {deleteTarget && (
        <DeleteAlertDialog
          alertName={deleteTarget.name}
          isOpen={true}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
          isDeleting={deleteMutation.isPending}
          error={deleteMutation.error}
        />
      )}
    </div>
  );
}
