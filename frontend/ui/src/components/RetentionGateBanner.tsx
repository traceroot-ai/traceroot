"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { PLANS, PlanType } from "@traceroot/core";
import { Button } from "@/components/ui/button";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import type { RetentionErrorDetail } from "@/lib/api/retention";
import { useT } from "@/lib/i18n/provider";

interface RetentionGateBannerProps {
  projectId: string;
  detail: RetentionErrorDetail;
}

// Shown when a by-id fetch (a single trace) 403s for being outside the plan's
// retention window. List pages don't use this — they silently clamp the query
// window instead — so there is only this one "detail" form.
export function RetentionGateBanner({ projectId, detail }: RetentionGateBannerProps) {
  const t = useT();
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
        <p className="text-[13px] font-medium text-foreground">{t("componentsRetention.title")}</p>
        <p className="text-[12px] text-muted-foreground">
          {t("componentsRetention.text", { plan: planLabel, days: detail.retention_days })}
        </p>
        <Button
          variant="default"
          size="sm"
          className="mt-1"
          disabled={!workspace}
          onClick={() => setShowPricing(true)}
        >
          {t("componentsRetention.upgradePlan")}
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
