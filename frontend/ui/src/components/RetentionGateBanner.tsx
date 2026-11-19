"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { PLANS, PlanType } from "@traceroot/core";
import { Button } from "@/components/ui/button";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import type { RetentionErrorDetail } from "@/lib/api/retention";

interface RetentionGateBannerProps {
  projectId: string;
  detail: RetentionErrorDetail;
}

// Shown when a by-id fetch (a single trace) 403s for being outside the plan's
// retention window. List pages don't use this — they silently clamp the query
// window instead — so there is only this one "detail" form.
export function RetentionGateBanner({ projectId, detail }: RetentionGateBannerProps) {
  const [showPricing, setShowPricing] = useState(false);
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";
  const { data: workspace } = useWorkspace(workspaceId);

  // Reuse the canonical plan display name; fall back to the raw plan id for an
  // unrecognized plan rather than showing nothing.
  const planLabel = (PLANS as Record<string, { name: string }>)[detail.plan]?.name ?? detail.plan;

  return (
    <>
      <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
        <Lock className="h-8 w-8 text-muted-foreground" />
        <p className="text-[13px] font-medium text-foreground">
          This trace is outside your retention window
        </p>
        <p className="text-[12px] text-muted-foreground">
          Your {planLabel} plan retains the last {detail.retention_days} days of data. Upgrade to
          access this trace.
        </p>
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
