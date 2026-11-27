"use client";

import { useParams } from "next/navigation";
import { PlanType } from "@traceroot/core";
import { BillingTab } from "@/ee/features/billing/BillingTab";
import { useWorkspace } from "@/features/workspaces/hooks";
import { WorkspaceSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function WorkspaceSettingsBillingPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  const { data: workspace, isLoading } = useWorkspace(workspaceId);

  return (
    <WorkspaceSettingsLayout workspaceId={workspaceId} tab="billing">
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
    </WorkspaceSettingsLayout>
  );
}
