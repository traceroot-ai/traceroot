"use client";

import { useParams, useRouter } from "next/navigation";
import { PageBackHeader } from "@/features/dashboards/components/PageBackHeader";
import { LoadingState } from "@/components/ui/loading-state";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { LoopForm } from "@/features/loops/components/loop-form";
import { LoopStatusBadge } from "@/features/loops/components/loop-status-badge";
import { useLoop, useUpdateLoop } from "@/features/loops/hooks/use-loops";

export default function EditLoopPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const loopId = params.loopId as string;
  const { data: loop, isLoading, error } = useLoop(projectId, loopId);
  const updateMutation = useUpdateLoop(projectId, loopId);
  const back = `/projects/${projectId}/loops`;

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <PageBackHeader
          backHref={back}
          backLabel="Loops"
          title={loop ? `Edit ${loop.name}` : "Edit Loop"}
          actions={
            loop ? (
              <LoopStatusBadge
                status={loop.status}
                pauseReason={loop.pauseReason}
                failureStreak={loop.failureStreak}
              />
            ) : undefined
          }
        />
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label="Loading Loop..." />
            </div>
          ) : error || !loop ? (
            <p className="p-4 text-[13px] text-destructive">
              {error instanceof Error ? error.message : "Loop not found"}
            </p>
          ) : (
            // Keyed so a refetch after saving does not reset a form the person is still editing.
            <LoopForm
              key={loop.id}
              projectId={projectId}
              loop={loop}
              isPending={updateMutation.isPending}
              error={updateMutation.error}
              onCancel={() => router.push(back)}
              onSubmit={(values) =>
                updateMutation.mutate(values, { onSuccess: () => router.push(back) })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
