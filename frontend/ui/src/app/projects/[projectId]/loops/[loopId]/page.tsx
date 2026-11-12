"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Pause, Pencil, Play } from "lucide-react";
import { PageBackHeader } from "@/features/dashboards/components/PageBackHeader";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ListPagination } from "@/components/list-pagination";
import { useLayout } from "@/components/layout/app-layout";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useProject } from "@/features/projects/hooks";
import { LoopFindingsTab } from "@/features/loops/components/loop-findings-tab";
import { LoopMemoryList } from "@/features/loops/components/loop-memory-list";
import { LoopRunsTable } from "@/features/loops/components/loop-runs-table";
import { LoopStatusBadge } from "@/features/loops/components/loop-status-badge";
import { RunLoop } from "@/features/loops/components/run-loop";
import {
  useLoop,
  useLoopFindings,
  useLoopMemory,
  useLoopPlanLimit,
  useLoopRuns,
  useSetLoopStatus,
  ACTIVE_RUN_POLL_MS,
  type Loop,
} from "@/features/loops/hooks/use-loops";
import { describeSchedule, formatInZone } from "@/features/loops/loop-display";
import { formatCost, formatRelativeTime } from "@/lib/utils";
import { ACTIVE_RUN_STATUSES, type LoopRunDto } from "@traceroot/core/loops/pure";

function modelLabel(loop: Loop): string {
  if (!loop.model) return "Project Agent model";
  return loop.source === "byok"
    ? `${loop.model} (BYOK, ${loop.provider ?? "provider"})`
    : loop.model;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[13px] text-foreground">{children}</p>
    </div>
  );
}

export default function LoopDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const loopId = params.loopId as string;
  const [runPage, setRunPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const { data: project } = useProject(projectId);
  const { data: loop, isLoading, error } = useLoop(projectId, loopId);
  const runs = useLoopRuns(projectId, loopId, { page: runPage, limit: pageSize });
  const findings = useLoopFindings(projectId, loopId);
  const memory = useLoopMemory(projectId, loopId);
  const planLimit = useLoopPlanLimit(project?.workspace_id);
  const statusMutation = useSetLoopStatus(projectId);
  const { setAiContext, setAiInitialSessionId, setAiPanelOpen } = useLayout();

  // The transcript opens in the assistant rail, which loads the run's session.
  const openTranscript = (run: LoopRunDto) => {
    if (!run.sessionId) return;
    setAiContext(null);
    setAiInitialSessionId(run.sessionId);
    setAiPanelOpen(true);
  };
  useEffect(
    () => () => {
      setAiPanelOpen(false);
      setAiInitialSessionId(undefined);
    },
    [setAiPanelOpen, setAiInitialSessionId],
  );

  const back = `/projects/${projectId}/loops`;
  const active = !!runs.data?.data.some((r) =>
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status),
  );

  const header = (
    <PageBackHeader
      backHref={back}
      backLabel="Loops"
      title={loop?.name ?? "Loop"}
      actions={
        loop ? (
          <>
            <LoopStatusBadge
              status={loop.status}
              pauseReason={loop.pauseReason}
              failureStreak={loop.failureStreak}
            />
            <RunLoop projectId={projectId} loopId={loop.id} active={active} />
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[12px]"
              disabled={statusMutation.isPending}
              onClick={() =>
                statusMutation.mutate({
                  loopId: loop.id,
                  action: loop.status === "active" ? "pause" : "resume",
                })
              }
            >
              {loop.status === "active" ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {loop.status === "active" ? "Pause" : "Resume"}
            </Button>
            <Link
              href={`/projects/${projectId}/loops/${loop.id}/edit`}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-input px-3 text-[12px] hover:bg-muted"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Link>
          </>
        ) : undefined
      }
    />
  );

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />
      <div className="flex flex-1 flex-col overflow-hidden">
        {header}
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <LoadingState label="Loading Loop..." />
          </div>
        ) : error || !loop ? (
          <p className="p-4 text-[13px] text-destructive">
            {error instanceof Error ? error.message : "Loop not found"}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {statusMutation.error && (
              <p className="border-b border-border px-4 py-2 text-[12px] text-destructive">
                {statusMutation.error.message}
              </p>
            )}
            {loop.status === "paused_by_system" && (
              <p className="border-b border-border bg-warning-soft px-4 py-2 text-[12px] text-warning">
                Paused automatically after {loop.failureStreak} scheduled runs in a row failed. Fix
                the cause (see the latest failed run), then resume.
              </p>
            )}
            {planLimit.data?.blocked && (
              <p className="border-b border-border bg-warning-soft px-4 py-2 text-[12px] text-warning">
                Your Free plan&apos;s {planLimit.data.included} Loop runs are used (
                {planLimit.data.runsUsed} / {planLimit.data.included}). Runs are skipped until you{" "}
                <Link
                  href={`/workspaces/${project?.workspace_id}/settings/billing`}
                  className="font-medium underline"
                >
                  upgrade
                </Link>
                .
              </p>
            )}
            {loop.dryRun && (
              <p className="border-b border-border bg-muted px-4 py-2 text-[12px] text-muted-foreground">
                Dry run: this Loop records a summary for each run and writes no findings.
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-border px-4 py-3 md:grid-cols-3 lg:grid-cols-6">
              <Fact label="Schedule">{describeSchedule(loop.schedule)}</Fact>
              <Fact label="Next run">
                {loop.status === "active" && loop.nextRunAt
                  ? formatInZone(
                      new Date(loop.nextRunAt),
                      loop.schedule.kind === "interval" ? null : loop.schedule.timezone,
                    )
                  : "—"}
              </Fact>
              <Fact label="Model">{modelLabel(loop)}</Fact>
              <Fact label="Last run">
                {loop.lastRunAt ? formatRelativeTime(loop.lastRunAt) : "Never"}
              </Fact>
              <Fact label="Runs · avg cost">
                {loop.runCount} · {formatCost(loop.avgCostUsd)}
              </Fact>
              <Fact label="Signals found">{loop.signalCount}</Fact>
            </div>

            <Tabs defaultValue="runs" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="px-4" aria-label="Loop">
                <TabsTrigger value="runs" count={runs.data?.meta.total}>
                  Runs
                </TabsTrigger>
                <TabsTrigger value="findings" count={findings.data?.meta.total}>
                  Findings
                </TabsTrigger>
                <TabsTrigger value="memory" count={memory.data?.length}>
                  Memory
                </TabsTrigger>
              </TabsList>

              <TabsContent value="runs" className="min-h-0 flex-1 overflow-auto bg-background">
                {runs.isLoading ? (
                  <div className="flex h-48 items-center justify-center">
                    <LoadingState label="Loading runs..." />
                  </div>
                ) : runs.error ? (
                  <p className="p-4 text-[13px] text-destructive">Error loading runs</p>
                ) : (runs.data?.data.length ?? 0) === 0 ? (
                  <div className="flex h-48 flex-col items-center justify-center gap-1.5 text-center">
                    <p className="text-[13px] text-muted-foreground">No runs yet</p>
                    <p className="max-w-md text-[12px] text-muted-foreground">
                      {loop.status === "active" && loop.nextRunAt
                        ? `The first scheduled run is ${formatInZone(
                            new Date(loop.nextRunAt),
                            loop.schedule.kind === "interval" ? null : loop.schedule.timezone,
                          )}. `
                        : "No run is scheduled while the Loop is paused. "}
                      Use Run now to start one.
                    </p>
                  </div>
                ) : (
                  <>
                    {active && (
                      <p className="border-b border-border px-4 py-1.5 text-[12px] text-muted-foreground">
                        A run is queued or running. This page looks again every{" "}
                        {ACTIVE_RUN_POLL_MS / 1000} s; a worker picks queued runs up on its next
                        tick.
                      </p>
                    )}
                    <LoopRunsTable runs={runs.data!.data} onOpenTranscript={openTranscript} />
                    <ListPagination
                      page={runPage}
                      limit={pageSize}
                      total={runs.data!.meta.total}
                      onPageChange={setRunPage}
                      onLimitChange={(n) => {
                        setPageSize(n);
                        setRunPage(0);
                      }}
                    />
                  </>
                )}
              </TabsContent>

              <TabsContent value="findings" className="min-h-0 flex-1 overflow-auto bg-background">
                {findings.isLoading ? (
                  <div className="flex h-48 items-center justify-center">
                    <LoadingState label="Loading findings..." />
                  </div>
                ) : (
                  <LoopFindingsTab
                    projectId={projectId}
                    findings={findings.data?.data ?? []}
                    dryRun={loop.dryRun}
                  />
                )}
              </TabsContent>

              <TabsContent value="memory" className="min-h-0 flex-1 overflow-auto bg-background">
                {memory.isLoading ? (
                  <div className="flex h-48 items-center justify-center">
                    <LoadingState label="Loading memory..." />
                  </div>
                ) : (
                  <LoopMemoryList loopId={loop.id} notes={memory.data ?? []} />
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  );
}
