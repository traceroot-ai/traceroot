"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PageBackHeader } from "@/features/dashboards/components/PageBackHeader";
import { SectionBox } from "@/features/dashboards/components/SectionBox";
import { LoadingState } from "@/components/ui/loading-state";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { LoopForm } from "@/features/loops/components/loop-form";
import { LoopMemoryList } from "@/features/loops/components/loop-memory-list";
import { useLoop, useLoopMemory, useUpdateLoop } from "@/features/loops/hooks/use-loops";
import { useListReturnHref } from "@/lib/hooks/use-list-return";

export default function EditLoopPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const loopId = params.loopId as string;
  const { data: loop, isLoading, error } = useLoop(projectId, loopId);
  const memory = useLoopMemory(projectId);
  const updateMutation = useUpdateLoop(projectId, loopId);
  const listHref = useListReturnHref(`loops:${projectId}`, `/projects/${projectId}/loops`);
  // Opened from the loop's own page (`?from=detail`), Back, Cancel and Save return there;
  // otherwise to the list, on the page and filters it was showing.
  const fromDetail = searchParams.get("from") === "detail";
  const back = fromDetail ? `/projects/${projectId}/loops/${loopId}` : listHref;

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <PageBackHeader
          backHref={back}
          backLabel={fromDetail ? (loop?.name ?? "Loop") : "Loops"}
          title={loop ? `Edit loop - ${loop.name}` : "Edit loop"}
        />
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label="Loading loop..." />
            </div>
          ) : !loop ? (
            // Only a loop that never loaded: once it has, a failed background refetch
            // keeps the form and its unsaved edits.
            <p className="p-4 text-[13px] text-destructive">
              {error instanceof Error ? error.message : "Loop not found"}
            </p>
          ) : (
            <LoopForm
              projectId={projectId}
              loop={loop}
              isPending={updateMutation.isPending}
              error={updateMutation.error}
              onCancel={() => router.push(back)}
              onSubmit={(values) =>
                updateMutation.mutate(values, { onSuccess: () => router.push(back) })
              }
            >
              {/* What the project's loops remember between runs: shown here, not edited. */}
              <SectionBox label="Memory">
                {memory.isLoading ? (
                  <div className="flex h-32 items-center justify-center">
                    <LoadingState label="Loading memory..." />
                  </div>
                ) : memory.error ? (
                  <p className="p-4 text-[12px] text-destructive">{memory.error.message}</p>
                ) : (
                  <>
                    <p className="px-4 py-2 text-[12px] text-muted-foreground">
                      Read-only. The notes every loop in this project keeps between runs, each with
                      the loop that last wrote it.
                    </p>
                    <LoopMemoryList notes={memory.data ?? []} />
                  </>
                )}
              </SectionBox>
            </LoopForm>
          )}
        </div>
      </div>
    </div>
  );
}
