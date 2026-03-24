"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { PlanType } from "@traceroot/core";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import { BillingTab } from "@/ee/features/billing/BillingTab";
import { getWorkspace } from "@/lib/api";
import { SettingsLayout, WORKSPACE_SETTINGS_TABS } from "@/features/settings/settings-layout";

export default function WorkspaceSettingsBillingPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  const { data: workspace, isLoading } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId),
  });

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />

      <SettingsLayout
        tabs={WORKSPACE_SETTINGS_TABS}
        activeTab="billing"
        basePath={`/workspaces/${workspaceId}/settings`}
        crossLink={{ label: "Project Settings", href: `/workspaces/${workspaceId}/projects` }}
      >
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <BillingTab
            workspaceId={workspaceId}
            currentPlan={(workspace?.billingPlan as PlanType) || PlanType.FREE}
            hasSubscription={!!workspace?.billingSubscriptionId}
            currentUsage={workspace?.currentUsage}
          />
        )}
      </SettingsLayout>
    </div>
  );
}
