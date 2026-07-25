"use client";

import { useState, useCallback } from "react";
import { PlanType } from "@traceroot/core";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";

const PLAN_RETENTION_DAYS: Record<string, number | null> = {
  [PlanType.FREE]: 15,
  [PlanType.STARTER]: 30,
  [PlanType.PRO]: 90,
  [PlanType.ENTERPRISE]: null,
};

export function useRetention(projectId: string) {
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";
  const { data: workspace } = useWorkspace(workspaceId, !!workspaceId);

  const billingPlan = (workspace?.billingPlan as string) || PlanType.FREE;
  const retentionDays = Object.prototype.hasOwnProperty.call(PLAN_RETENTION_DAYS, billingPlan)
    ? PLAN_RETENTION_DAYS[billingPlan]
    : 15;

  const [showPricing, setShowPricing] = useState(false);
  const onUpgradeClick = useCallback(() => setShowPricing(true), []);
  const closePricing = useCallback(() => setShowPricing(false), []);

  return {
    retentionDays,
    showPricing,
    onUpgradeClick,
    closePricing,
    workspaceId,
    billingPlan,
  };
}
