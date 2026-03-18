"use client";

import { useState, useEffect } from "react";
import { ArrowRight, ExternalLink, AlertCircle, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PLANS, PlanType, isUpgrade, EVENT_QUOTAS, AI_RUN_QUOTAS } from "@traceroot/core";
import type { UsageStats } from "@/types/api";
import {
  createCheckoutSession,
  changePlan,
  getPortalUrl,
  getSubscriptionInfo,
  type SubscriptionInfo,
} from "./api";

interface BillingTabProps {
  workspaceId: string;
  currentPlan?: PlanType;
  hasSubscription?: boolean; // true if workspace has billingSubscriptionId
  currentUsage?: UsageStats | null;
}

export function BillingTab({
  workspaceId,
  currentPlan = PlanType.FREE,
  hasSubscription = false,
  currentUsage,
}: BillingTabProps) {
  const [showPricingDialog, setShowPricingDialog] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscriptionInfo, setSubscriptionInfo] = useState<SubscriptionInfo | null>(null);

  const currentPlanConfig = PLANS[currentPlan];
  const aiUsage = currentUsage?.ai;
  const eventQuota = EVENT_QUOTAS[currentPlan];
  const aiRunQuota = AI_RUN_QUOTAS[currentPlan];

  // Fetch live subscription info from Stripe
  useEffect(() => {
    if (!hasSubscription) return;

    getSubscriptionInfo(workspaceId)
      .then(setSubscriptionInfo)
      .catch((err) => {
        console.error("Failed to fetch subscription info:", err);
      });
  }, [workspaceId, hasSubscription]);

  async function handlePlanSelect(newPlan: PlanType) {
    if (newPlan === currentPlan) return;

    // Enterprise = contact sales
    if (newPlan === PlanType.ENTERPRISE) {
      window.open("https://cal.com/traceroot/30min", "_blank");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (!hasSubscription && newPlan !== PlanType.FREE) {
        // No subscription yet, need to go through checkout
        const { url } = await createCheckoutSession(workspaceId, newPlan);
        window.location.href = url;
      } else {
        // Has subscription, use change-plan (upgrade, downgrade, or cancel to free)
        const result = await changePlan(workspaceId, newPlan);
        if (result.success) {
          setShowPricingDialog(false);
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

  async function handleOpenPortal() {
    setIsLoading(true);
    try {
      const { url } = await getPortalUrl(workspaceId);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal");
    } finally {
      setIsLoading(false);
    }
  }

  function getButtonText(planId: PlanType): string {
    if (planId === currentPlan) return "Current Plan";
    if (planId === PlanType.ENTERPRISE) return "Contact Sales";
    if (planId === PlanType.FREE) return "Downgrade";
    if (isUpgrade(currentPlan, planId)) return "Upgrade";
    return "Downgrade";
  }

  function formatCost(cost: number): string {
    if (cost < 0.01) return cost > 0 ? "< $0.01" : "$0.00";
    return `$${cost.toFixed(2)}`;
  }

  function formatTokens(input: number, output: number): string {
    return `${(input + output).toLocaleString()} tokens`;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">Billing</h2>
        <p className="text-sm text-muted-foreground">
          Manage your subscription and billing details
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Current Plan Section */}
      <div className="border">
        <div className="border-b bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-medium">Current plan</h3>
        </div>
        <div className="px-4 py-3">
          <p className="text-sm text-muted-foreground">
            You are currently on the{" "}
            <span className="font-medium text-foreground">{currentPlanConfig.name}</span> plan.
          </p>

          {/* Cancellation Notice */}
          {subscriptionInfo?.cancellation && (
            <div className="mt-3 flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
              <div className="text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-200">
                  Subscription ending
                </p>
                <p className="text-amber-700 dark:text-amber-300">
                  Your subscription will be canceled on{" "}
                  {new Date(subscriptionInfo.cancellation.cancelAt).toLocaleDateString()}. You will
                  be downgraded to the Free plan after this date.
                </p>
              </div>
            </div>
          )}

          {/* Scheduled Plan Change Notice */}
          {subscriptionInfo?.scheduledChange && (
            <div className="mt-3 flex items-start gap-2 border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950">
              <CalendarClock className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
              <div className="text-sm">
                <p className="font-medium text-blue-800 dark:text-blue-200">
                  Plan change scheduled
                </p>
                <p className="text-blue-700 dark:text-blue-300">
                  Your plan will change to{" "}
                  <span className="font-medium">
                    {PLANS[subscriptionInfo.scheduledChange.newPlan as PlanType]?.name ||
                      subscriptionInfo.scheduledChange.newPlan}
                  </span>{" "}
                  on {new Date(subscriptionInfo.scheduledChange.switchAt).toLocaleDateString()}.
                </p>
              </div>
            </div>
          )}

          {/* Billing Period */}
          {subscriptionInfo?.billingPeriod && !subscriptionInfo.cancellation && (
            <p className="mt-2 text-xs text-muted-foreground">
              Current billing period:{" "}
              {new Date(subscriptionInfo.billingPeriod.start).toLocaleDateString()} -{" "}
              {new Date(subscriptionInfo.billingPeriod.end).toLocaleDateString()}
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowPricingDialog(true)}>
              Change plan
            </Button>
            {hasSubscription && (
              <Button variant="ghost" size="sm" onClick={handleOpenPortal} disabled={isLoading}>
                Manage billing <ExternalLink className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Event Usage Section */}
      <div className="border">
        <div className="border-b bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-medium">Event Usage</h3>
        </div>
        <div className="px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {currentPlan === PlanType.FREE
              ? `Events used this period. Free plan includes ${eventQuota.included.toLocaleString()} events (hard cap).`
              : eventQuota.included === Infinity
                ? "Events used this billing period. Unlimited events included."
                : `Events used this billing period. ${eventQuota.included.toLocaleString()} included, then ${eventQuota.overageLabel}.`}
          </p>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Traces</span>
              <span>{(currentUsage?.traces ?? 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Spans</span>
              <span>{(currentUsage?.spans ?? 0).toLocaleString()}</span>
            </div>
            <div className="-mx-4 flex justify-between border-t px-4 pt-2">
              <span className="font-medium">Total events</span>
              <span className="font-medium">
                {((currentUsage?.traces ?? 0) + (currentUsage?.spans ?? 0)).toLocaleString()}
                {eventQuota.included === Infinity
                  ? ""
                  : ` / ${eventQuota.included.toLocaleString()}`}
              </span>
            </div>
          </div>
          {currentUsage?.updatedAt && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last updated: {new Date(currentUsage.updatedAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>

      {/* AI Usage Section */}
      <div className="border">
        <div className="border-b bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-medium">AI Usage</h3>
        </div>
        <div className="space-y-4 px-4 py-3">
          {/* AI Runs */}
          <div>
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium">AI Runs</p>
              <span className="text-sm font-medium">
                {aiUsage?.runsUsed ?? 0}
                {aiRunQuota.included === Infinity
                  ? ""
                  : ` / ${aiRunQuota.included}`}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              1 run = 1 chat message, 1 agent turn, 1 auto-triage, or 1 issue creation.
              {currentPlan !== PlanType.FREE &&
                currentPlan !== PlanType.ENTERPRISE &&
                ` Overage: ${aiRunQuota.overageLabel}.`}
            </p>
          </div>

          {/* System Models */}
          <div>
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium">TR AI Token Cost</p>
              <span className="text-sm font-medium">
                {formatCost(aiUsage?.systemUsage.cost ?? 0)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {currentPlan === PlanType.FREE
                ? "Included in your plan (we pay)."
                : "Included with runs; 1.05x markup on overage token cost."}
            </p>
            <div className="mt-2 flex justify-between text-sm text-muted-foreground">
              <span>Input / Output</span>
              <span>
                {(aiUsage?.systemUsage.inputTokens ?? 0).toLocaleString()} /{" "}
                {(aiUsage?.systemUsage.outputTokens ?? 0).toLocaleString()}
              </span>
            </div>
          </div>

          {/* BYOK Models */}
          {aiUsage && (aiUsage.byokUsage.messages > 0 || aiUsage.byModel.some((m) => m.isByok)) && (
            <div>
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium">BYOK Models</p>
                <span className="text-sm text-muted-foreground">
                  {formatTokens(aiUsage.byokUsage.inputTokens, aiUsage.byokUsage.outputTokens)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Your own API keys. Not billed by TraceRoot (runs still count).
              </p>
              <div className="mt-2 flex justify-between text-sm text-muted-foreground">
                <span>Input / Output</span>
                <span>
                  {aiUsage.byokUsage.inputTokens.toLocaleString()} /{" "}
                  {aiUsage.byokUsage.outputTokens.toLocaleString()}
                </span>
              </div>
            </div>
          )}

          {/* By Model breakdown */}
          {aiUsage && aiUsage.byModel.length > 0 && (
            <div className="-mx-4 border-t px-4 pt-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">By model</p>
              <div className="mt-2 space-y-1.5 text-sm">
                {aiUsage.byModel.map((row) => (
                  <div key={`${row.model}-${row.isByok}`} className="flex justify-between">
                    <span className="text-muted-foreground">
                      {row.model}
                      {row.isByok && <span className="ml-1 text-xs opacity-60">BYOK</span>}
                    </span>
                    <span className="text-muted-foreground">
                      {formatTokens(row.inputTokens, row.outputTokens)}
                      {!row.isByok && ` \u00b7 ${formatCost(row.cost)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Pricing Dialog */}
      <Dialog open={showPricingDialog} onOpenChange={setShowPricingDialog}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Choose a plan</DialogTitle>
            <DialogDescription>Select a plan that best fits your needs.</DialogDescription>
          </DialogHeader>
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
                          {getButtonText(planId)}
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
    </div>
  );
}
