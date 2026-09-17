"use client";

import { useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlanType } from "@traceroot/core";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import { BillingTab } from "@/ee/features/billing/BillingTab";
import { reconcileCheckout } from "@/ee/features/billing/api";
import { getWorkspace } from "@/lib/api";
import { SettingsLayout, WORKSPACE_SETTINGS_TABS } from "@/features/settings/settings-layout";

export default function WorkspaceSettingsBillingPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  const { data: workspace, isLoading } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId),
  });

  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const checkoutSessionId =
    searchParams.get("success") === "true" ? searchParams.get("session_id") : null;
  const reconciledSessionId = useRef<string | null>(null);

  // Back from Checkout: sync the subscription from Stripe now instead of waiting
  // for the webhook, then reload the workspace so the new plan shows.
  useEffect(() => {
    if (!checkoutSessionId || reconciledSessionId.current === checkoutSessionId) return;
    reconciledSessionId.current = checkoutSessionId;
    reconcileCheckout(workspaceId, checkoutSessionId)
      .catch((error) => console.error("Failed to reconcile checkout:", error))
      .finally(() => queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] }));
  }, [checkoutSessionId, workspaceId, queryClient]);

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />

      <SettingsLayout
        tabs={WORKSPACE_SETTINGS_TABS}
        activeTab="billing"
        basePath={`/workspaces/${workspaceId}/settings`}
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
