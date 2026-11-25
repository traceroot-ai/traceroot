"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { PlanType } from "@traceroot/core";
import { BillingTab } from "@/ee/features/billing/BillingTab";
import { getWorkspace } from "@/lib/api";
import { WorkspaceSettingsLayout } from "@/features/settings/scoped-settings-layout";
import { useT } from "@/lib/i18n/provider";

export default function WorkspaceSettingsBillingPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const t = useT();

  const { data: workspace, isLoading } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId),
  });

  return (
    <WorkspaceSettingsLayout workspaceId={workspaceId} tab="billing">
      {isLoading ? (
        <div className="text-sm text-muted-foreground">{t("shellCommon.loading")}</div>
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
