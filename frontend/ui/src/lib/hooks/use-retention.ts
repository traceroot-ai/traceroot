"use client";

import { useState, useCallback } from "react";
import { PlanType, getRetentionDays } from "@traceroot/core";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";

export function useRetention(projectId: string) {
  const { data: project, isPending: projectPending } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";
  const { data: workspace, isPending: workspacePending } = useWorkspace(workspaceId, !!workspaceId);

  // While either lookup is in flight the plan is unknown: report undefined so
  // consumers don't clamp or lock selections against the free plan's window
  // during the gap (a hard reload would briefly narrow every stored range).
  // Once the lookups settle, anything unresolved — a missing workspace, an
  // errored query, an unrecognized plan string — still fails closed to the
  // most restrictive window. (A disabled query reports pending forever, so
  // each pending flag only counts while its query is actually enabled.)
  const resolving = (!!projectId && projectPending) || (!!workspaceId && workspacePending);
  const billingPlan = (workspace?.billingPlan as string) || PlanType.FREE;
  const retentionDays = resolving ? undefined : getRetentionDays(billingPlan);

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
