"use client";

import { useParams } from "next/navigation";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { PageBackHeader } from "@/features/dashboards/components/PageBackHeader";
import { AlertForm } from "@/features/alerts/components/alert-form";

export default function NewAlertPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <PageBackHeader
          backHref={`/projects/${projectId}/alerts`}
          backLabel="Alerts"
          title="New Alert"
        />

        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
          <AlertForm projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
