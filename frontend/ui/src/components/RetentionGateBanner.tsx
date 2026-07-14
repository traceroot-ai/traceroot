"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { PlanType } from "@traceroot/core";
import { Button } from "@/components/ui/button";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import type { RetentionErrorDetail } from "@/lib/api/retention";

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  enterprise: "Enterprise",
};

interface RetentionGateBannerProps {
  projectId: string;
  detail: RetentionErrorDetail;
  variant?: "list" | "detail";
}

export function RetentionGateBanner({
  projectId,
  detail,
  variant = "list",
}: RetentionGateBannerProps) {
  const [showPricing, setShowPricing] = useState(false);
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";
  const { data: workspace } = useWorkspace(workspaceId);

  const planLabel = PLAN_LABELS[detail.plan] ?? detail.plan;

  return (
    <>
      <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
        <Lock className="h-8 w-8 text-muted-foreground" />
        {variant === "list" ? (
          <>
            <p className="text-[13px] font-medium text-foreground">
              Your {planLabel} plan includes {detail.retention_days} days of data retention
            </p>
            <p className="text-[12px] text-muted-foreground">
              Upgrade your plan to access older traces and data.
            </p>
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium text-foreground">
              This trace is outside your retention window
            </p>
            <p className="text-[12px] text-muted-foreground">
              Your {planLabel} plan retains the last {detail.retention_days} days of data. Upgrade
              to access this trace.
            </p>
          </>
        )}
        <Button
          variant="default"
          size="sm"
          className="mt-1"
          disabled={!workspace}
          onClick={() => setShowPricing(true)}
        >
          Upgrade Plan
        </Button>
      </div>

      <PricingDialog
        open={showPricing}
        onOpenChange={setShowPricing}
        workspaceId={workspaceId}
        currentPlan={(workspace?.billingPlan as PlanType) || PlanType.FREE}
        hasSubscription={!!workspace?.billingSubscriptionId}
      />
    </>
  );
}
