"use client";

import { useState, useCallback } from "react";
import { PlanType, getRetentionDays } from "@traceroot/core";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";

export function useRetention(projectId: string) {
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";
  const { data: workspace } = useWorkspace(workspaceId, !!workspaceId);

  const billingPlan = (workspace?.billingPlan as string) || PlanType.FREE;
  const retentionDays = getRetentionDays(billingPlan);

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
