"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { PlanType } from "@traceroot/core";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";

interface SidebarUpgradeButtonProps {
  projectId?: string | null;
  workspaceId?: string | null;
  collapsed: boolean;
}

export function SidebarUpgradeButton({ projectId, workspaceId: propWorkspaceId, collapsed }: SidebarUpgradeButtonProps) {
  const [showPricingDialog, setShowPricingDialog] = useState(false);

  // Resolve the workspace so the pricing dialog can act on its plan
  const { data: project } = useProject(projectId ?? "", !!projectId);
  const workspaceId = propWorkspaceId || project?.workspace_id || "";
  const { data: workspace } = useWorkspace(workspaceId, !!workspaceId);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={cn(
              "flex w-full items-center gap-2 py-2 text-[13px] transition-colors hover:bg-muted/50 disabled:opacity-50",
              collapsed ? "justify-center px-2" : "px-3",
            )}
            // Wait for the workspace record so the dialog acts on the real plan;
            // opening it with the FREE fallback could route a subscribed
            // workspace to checkout instead of change-plan.
            disabled={!workspace}
            onClick={() => setShowPricingDialog(true)}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            {!collapsed && "Upgrade"}
          </button>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right" sideOffset={16}>
            Upgrade
          </TooltipContent>
        )}
      </Tooltip>

      <PricingDialog
        open={showPricingDialog}
        onOpenChange={setShowPricingDialog}
        workspaceId={workspaceId}
        currentPlan={(workspace?.billingPlan as PlanType) || PlanType.FREE}
        hasSubscription={!!workspace?.billingSubscriptionId}
      />
    </>
  );
}
