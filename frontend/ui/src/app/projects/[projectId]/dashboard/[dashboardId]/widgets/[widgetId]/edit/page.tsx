"use client";

import { useParams } from "next/navigation";
import { WidgetBuilderPage } from "@/features/dashboards/components/WidgetBuilderPage";

export default function EditWidgetPage() {
  const params = useParams();
  return (
    // Keyed by widget: the builder hydrates its draft once behind a flag (so
    // the dashboard poll can't clobber in-progress edits), which means a
    // widgetId change without a remount would keep the previous widget's
    // draft. The key makes a different widget a fresh form; the same widget
    // across polls keeps its instance.
    <WidgetBuilderPage
      key={params.widgetId as string}
      projectId={params.projectId as string}
      dashboardId={params.dashboardId as string}
      widgetId={params.widgetId as string}
    />
  );
}
