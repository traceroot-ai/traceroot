"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PageBackHeader } from "@/features/dashboards/components/PageBackHeader";
import { LoadingState } from "@/components/ui/loading-state";
import { ListPagination } from "@/components/list-pagination";
import { useLayout } from "@/components/layout/app-layout";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useProject } from "@/features/projects/hooks";
import { DeleteLoopDialog } from "@/features/loops/components/delete-loop-dialog";
import { LoopActionsMenu } from "@/features/loops/components/loop-actions-menu";
import { LoopRunsTable } from "@/features/loops/components/loop-runs-table";
import { RunLoop } from "@/features/loops/components/run-loop";
import {
  isActiveRun,
  useDeleteLoop,
  useLoop,
  useLoopRun,
  useLoopRuns,
  useSetLoopStatus,
} from "@/features/loops/hooks/use-loops";
import { formatInZone, pauseDetail } from "@/features/loops/loop-display";
import { useWorkspace } from "@/features/workspaces/hooks";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useListReturnHref } from "@/lib/hooks/use-list-return";
import type { LoopRunDto } from "@traceroot/core/loops/pure";
import { LOOP_RUN_QUOTAS, PlanType } from "@traceroot/core";

export default function LoopDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const loopId = params.loopId as string;
  // `?run=<id>`: a signal's "Seen in run #n" link, which opens that run's transcript.
  const linkedRunId = useSearchParams().get("run");
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Page and page size live in the URL.
  const { state, updateLimit, goToPage } = useListPageState();

  // Back to the list on the page it was left on.
  const listPath = `/projects/${projectId}/loops`;
  const listHref = useListReturnHref(`loops:${projectId}`, listPath);

  const { data: project } = useProject(projectId);
  const { data: loop, isLoading, error } = useLoop(projectId, loopId);
  // A queued or running run: Run now waits, and the runs refetch quietly until it ends.
  const active = isActiveRun(loop?.lastRun);
  const runs = useLoopRuns(projectId, loopId, {
    page: state.page,
    limit: state.limit,
    poll: active,
  });
  // Whether the Free plan's Loop runs are used up: runs are skipped as blocked until it upgrades.
  const { data: workspace } = useWorkspace(project?.workspace_id ?? "");
  const planBlocked = workspace?.loopBlocked === true;
  const statusMutation = useSetLoopStatus(projectId);
  const deleteMutation = useDeleteLoop(projectId);
  const { openAiSession } = useLayout();

  // The linked run from the loaded page, or by id when it is on another page.
  const linkedOnPage = runs.data?.data.find((r) => r.id === linkedRunId);
  const linkedById = useLoopRun(
    projectId,
    loopId,
    linkedRunId && !runs.isLoading && !linkedOnPage ? linkedRunId : null,
  );
  const linkedRun = linkedRunId ? (linkedOnPage ?? linkedById.data) : undefined;

  // The transcript opens in the assistant rail, which loads the run's session.
  const openTranscript = useCallback(
    (run: LoopRunDto) => {
      if (run.sessionId) openAiSession(run.sessionId);
    },
    [openAiSession],
  );
  // Open the linked run's transcript once it has one; a refetch of the same run does not reopen it.
  const linkedSessionId = linkedRun?.sessionId;
  useEffect(() => {
    if (linkedSessionId) openAiSession(linkedSessionId);
  }, [linkedSessionId, openAiSession]);

  const stopped = loop ? loop.status !== "active" : false;

  // Everything the page has to say about the loop, in one notice bar.
  const notices: React.ReactNode[] = [];
  if (loop?.status === "paused_by_system") {
    notices.push(pauseDetail(loop.status, loop.failureStreak));
  } else if (loop?.status === "paused") {
    notices.push("Paused. It runs on its schedule again once resumed.");
  }
  if (planBlocked) {
    const included = LOOP_RUN_QUOTAS[PlanType.FREE].included;
    notices.push(
      <>
        Your Free plan&apos;s {included} loop runs are used (
        {workspace?.currentUsage?.loop?.runsUsed ?? 0} / {included}). Runs are skipped until you{" "}
        <Link
          href={`/workspaces/${project?.workspace_id}/settings/billing`}
          className="font-medium underline"
        >
          upgrade
        </Link>
        .
      </>,
    );
  }
  if (loop?.dryRun) {
    notices.push("Dry run: this loop records a summary for each run and writes no findings.");
  }
  if (linkedRun && !linkedRun.sessionId) {
    notices.push(`Run #${linkedRun.seq} has no transcript yet.`);
  } else if (linkedRunId && linkedById.error) {
    notices.push("The linked run was not found.");
  }
  if (statusMutation.error) notices.push(statusMutation.error.message);

  const actions = loop ? (
    <>
      <RunLoop
        projectId={projectId}
        loopId={loop.id}
        active={active}
        planBlocked={planBlocked}
        paused={stopped}
      />
      <LoopActionsMenu
        projectId={projectId}
        loop={loop}
        onToggleStatus={() =>
          statusMutation.mutate({ loopId: loop.id, action: stopped ? "resume" : "pause" })
        }
        onDelete={() => setDeleteOpen(true)}
        isStatusPending={statusMutation.isPending}
        fromDetail
      />
    </>
  ) : undefined;

  const runRows = runs.data?.data ?? [];

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <PageBackHeader
          backHref={listHref}
          backLabel="Loops"
          title={loop?.name ?? "Loop"}
          actions={actions}
        />
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <LoadingState label="Loading loop..." />
          </div>
        ) : error || !loop ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <p className="text-[13px] text-destructive">
              {error instanceof Error ? error.message : "Loop not found"}
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {notices.length > 0 && (
              <div className="border-b border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-warning">
                {notices.map((notice, i) => (
                  <p key={i}>{notice}</p>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-auto bg-background">
              {runs.isLoading ? (
                <div className="flex h-64 items-center justify-center">
                  <LoadingState label="Loading runs..." />
                </div>
              ) : runs.error ? (
                <div className="flex h-64 flex-col items-center justify-center gap-3">
                  <p className="text-[13px] text-destructive">Error loading runs</p>
                </div>
              ) : runRows.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center gap-3">
                  <p className="text-[13px] text-muted-foreground">No runs yet</p>
                  <p className="text-[12px] text-muted-foreground">
                    {loop.status === "active" && loop.nextRunAt
                      ? `The first scheduled run is ${formatInZone(
                          new Date(loop.nextRunAt),
                          loop.schedule.kind === "interval" ? null : loop.schedule.timezone,
                        )}. `
                      : "No run is scheduled while the loop is paused. "}
                    {stopped ? "Resume it to run it again." : "Use Run now to start one."}
                  </p>
                </div>
              ) : (
                <LoopRunsTable
                  runs={runRows}
                  onOpenTranscript={openTranscript}
                  highlightRunId={linkedRunId}
                />
              )}
            </div>

            <ListPagination
              page={state.page}
              limit={state.limit}
              total={runs.data?.meta.total ?? 0}
              onPageChange={goToPage}
              onLimitChange={updateLimit}
            />
          </div>
        )}
      </div>

      {loop && (
        <DeleteLoopDialog
          loopName={loop.name}
          isOpen={deleteOpen}
          onClose={() => {
            setDeleteOpen(false);
            deleteMutation.reset();
          }}
          onConfirm={() =>
            deleteMutation.mutate(loop.id, { onSuccess: () => router.push(listHref) })
          }
          isDeleting={deleteMutation.isPending}
          error={deleteMutation.error}
        />
      )}
    </div>
  );
}
