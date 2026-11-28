"use client";

import { useParams, useRouter } from "next/navigation";
import { PageBackHeader } from "@/features/dashboards/components/PageBackHeader";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { LoopForm } from "@/features/loops/components/loop-form";
import { useCreateLoop } from "@/features/loops/hooks/use-loops";
import { useListReturnHref } from "@/lib/hooks/use-list-return";

export default function NewLoopPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const createMutation = useCreateLoop(projectId);
  const listHref = useListReturnHref(`loops:${projectId}`, `/projects/${projectId}/loops`);

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <PageBackHeader backHref={listHref} backLabel="Loops" title="New loop" />
        <div className="flex-1 overflow-y-auto">
          <LoopForm
            projectId={projectId}
            isPending={createMutation.isPending}
            error={createMutation.error}
            onCancel={() => router.push(listHref)}
            onSubmit={(values) =>
              createMutation.mutate(values, { onSuccess: () => router.push(listHref) })
            }
          />
        </div>
      </div>
    </div>
  );
}
