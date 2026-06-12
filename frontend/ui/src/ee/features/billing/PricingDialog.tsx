"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PLANS, PlanType } from "@traceroot/core";
import { createCheckoutSession, changePlan } from "./api";
import { getPlanButtonText, resolvePlanAction } from "./plan-actions";

interface PricingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  currentPlan?: PlanType;
  hasSubscription?: boolean; // true if workspace has billingSubscriptionId
}

export function PricingDialog({
  open,
  onOpenChange,
  workspaceId,
  currentPlan = PlanType.FREE,
  hasSubscription = false,
}: PricingDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePlanSelect(newPlan: PlanType) {
    const action = resolvePlanAction(currentPlan, newPlan, hasSubscription);

    if (action.type === "none") return;

    if (action.type === "contact-sales") {
      window.open("https://cal.com/traceroot/30min", "_blank", "noopener,noreferrer");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (action.type === "checkout") {
        const { url } = await createCheckoutSession(workspaceId, newPlan);
        window.location.href = url;
      } else {
        const result = await changePlan(workspaceId, newPlan);
        if (result.success) {
          onOpenChange(false);
          // Reload to reflect new plan
          window.location.reload();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change plan");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Choose a plan</DialogTitle>
          <DialogDescription>Select a plan that best fits your needs.</DialogDescription>
        </DialogHeader>
        {error && (
          <div className="border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="py-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {(Object.entries(PLANS) as [PlanType, (typeof PLANS)[PlanType]][]).map(
              ([planId, plan]) => {
                const isCurrentPlan = planId === currentPlan;
                const isEnterprise = planId === PlanType.ENTERPRISE;

                return (
                  <div
                    key={planId}
                    className={cn(
                      "flex flex-col border",
                      plan.highlighted && "border-foreground shadow-md",
                    )}
                  >
                    {/* Plan header */}
                    <div className="border-b px-4 pb-3 pt-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-lg font-semibold">{plan.name}</h3>
                        {plan.badge && (
                          <span className="rounded-full bg-muted px-2 py-1 text-xs">
                            {plan.badge}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                    </div>

                    {/* Price */}
                    <div className="border-b px-4 py-3">
                      <div>
                        {plan.price !== null ? (
                          <>
                            <span className="text-2xl font-bold">${plan.price}</span>
                            <span className="text-muted-foreground"> per month</span>
                          </>
                        ) : (
                          <span className="text-2xl font-bold">Custom</span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{plan.support} support</p>
                    </div>

                    {/* Features */}
                    <div className="flex-1 px-4 py-3">
                      <ul className="space-y-2">
                        {plan.features.map((feature, index) => (
                          <li key={index} className="text-sm">
                            {feature}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* CTA Button */}
                    <div className="px-4 pb-4">
                      <Button
                        variant={plan.highlighted ? "default" : "outline"}
                        className="w-full justify-between"
                        disabled={isCurrentPlan || (isLoading && !isEnterprise)}
                        onClick={() => handlePlanSelect(planId)}
                      >
                        {getPlanButtonText(currentPlan, planId)}
                        {!isCurrentPlan && <ArrowRight className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                );
              },
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
