"use client";

import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";
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
          <DialogDescription>
            Start free. Bring your own model keys on every plan, or use hosted models.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="py-2">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
            {(Object.entries(PLANS) as [PlanType, (typeof PLANS)[PlanType]][]).map(
              ([planId, plan]) => {
                const isCurrentPlan = planId === currentPlan;
                const isEnterprise = planId === PlanType.ENTERPRISE;

                return (
                  <div
                    key={planId}
                    className={cn(
                      "-mb-px -mr-px flex flex-col border p-5",
                      plan.highlighted
                        ? "relative z-10 border-brand-border bg-brand-soft"
                        : "border-border",
                    )}
                  >
                    <div className="flex h-5 items-center justify-between text-[12px] font-medium text-muted-foreground">
                      <h3 className="font-medium">{plan.name}</h3>
                      {plan.badge && (
                        <span className="rounded-[2px] border border-brand-border bg-background px-1.5 py-0.5 text-brand">
                          {plan.badge}
                        </span>
                      )}
                    </div>

                    <div className="mt-4 flex h-10 items-baseline gap-1.5">
                      {plan.price !== null ? (
                        <>
                          <span className="text-[32px] font-normal leading-10 tracking-tight">
                            ${plan.price}
                          </span>
                          <span className="text-[12px] text-muted-foreground">per month</span>
                        </>
                      ) : (
                        <span className="text-[32px] font-normal leading-10 tracking-tight">
                          Custom
                        </span>
                      )}
                    </div>

                    <p className="mt-2 text-[13px] text-muted-foreground">{plan.description}</p>

                    <ul className="mb-5 mt-3 flex-1 space-y-1">
                      {[...plan.features, `${plan.support} support`].map((feature) => (
                        <li
                          key={feature}
                          className="flex items-start gap-2 py-0.5 text-[13px] text-muted-foreground"
                        >
                          <Check className="mt-1 h-3 w-3 shrink-0 text-foreground/45" />
                          {feature}
                        </li>
                      ))}
                    </ul>

                    <Button
                      variant={plan.highlighted ? "default" : "outline"}
                      className="w-full justify-between"
                      disabled={isCurrentPlan || (isLoading && !isEnterprise)}
                      onClick={() => handlePlanSelect(planId)}
                    >
                      {getPlanButtonText(currentPlan, planId)}
                      {!isCurrentPlan && <ArrowRight className="h-3.5 w-3.5" />}
                    </Button>
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
