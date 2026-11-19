"use client";

import { useParams } from "next/navigation";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { WidgetBuilderPage } from "@/features/dashboards/components/WidgetBuilderPage";

export default function NewWidgetPage() {
  const params = useParams();
  return (
    <>
      <ProjectBreadcrumb projectId={params.projectId as string} />
      <WidgetBuilderPage
        projectId={params.projectId as string}
        dashboardId={params.dashboardId as string}
      />
    </>
  );
}
