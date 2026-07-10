"use client";

import { useParams } from "next/navigation";
import { WidgetBuilderPage } from "@/features/dashboards/components/WidgetBuilderPage";

export default function EditWidgetPage() {
  const params = useParams();
  return (
    <WidgetBuilderPage
      projectId={params.projectId as string}
      dashboardId={params.dashboardId as string}
      widgetId={params.widgetId as string}
    />
  );
}
