"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ExternalLink, AlertCircle, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PLANS,
  PlanType,
  EVENT_QUOTAS,
  AI_RUN_QUOTAS,
  RCA_RUN_QUOTAS,
  DETECTOR_RUN_QUOTAS,
} from "@traceroot/core";
import type { UsageStats, AIUsageByModel } from "@/types/api";
import { formatRcaQuotaLabel, formatDetectorScanLabel } from "./usage-labels";
import { PricingDialog } from "./PricingDialog";

function formatCost(cost: number): string {
  if (cost < 0.01) return cost > 0 ? "< $0.01" : "$0.00";
  return `$${cost.toFixed(2)}`;
}

function formatTokens(input: number, output: number): string {
  return `${(input + output).toLocaleString()} tokens`;
}

function formatModelUsage(row: AIUsageByModel): string {
  const cost = formatCost(row.cost);
  return row.isByok
    ? `${formatTokens(row.inputTokens, row.outputTokens)} · ${cost} (not billed)`
    : `${formatTokens(row.inputTokens, row.outputTokens)} · ${cost}`;
}

function isAttributedModelUsage(row: AIUsageByModel): boolean {
  return row.model !== "unknown";
}

interface UsageSectionProps {
  title: string;
  runsLabel: string;
  runsValue: string;
  runsHelper: string;
  systemCost: number;
  systemHelper: string;
  systemInputTokens: number;
  systemOutputTokens: number;
  byModel: AIUsageByModel[] | undefined;
}

function UsageSection({
  title,
  runsLabel,
  runsValue,
  runsHelper,
  systemCost,
  systemHelper,
  systemInputTokens,
  systemOutputTokens,
  byModel,
}: UsageSectionProps) {
  const attributedByModel = byModel?.filter(isAttributedModelUsage);

  return (
    <div className="border">
      <div className="border-b bg-muted/30 px-4 py-3">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="space-y-4 px-4 py-3">
        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium">{runsLabel}</p>
            <span className="text-sm font-medium">{runsValue}</span>
          </div>
          <p className="text-xs text-muted-foreground">{runsHelper}</p>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium">Internal Models</p>
            <span className="text-sm font-medium">{formatCost(systemCost)}</span>
          </div>
          <p className="text-xs text-muted-foreground">{systemHelper}</p>
          <div className="mt-2 flex justify-between text-sm text-muted-foreground">
            <span>Input / Output</span>
            <span>
              {systemInputTokens.toLocaleString()} / {systemOutputTokens.toLocaleString()}
            </span>
          </div>
        </div>

        {attributedByModel && attributedByModel.length > 0 && (
          <div className="-mx-4 border-t px-4 pt-3">
            <p className="text-xs font-medium uppercase text-muted-foreground">By model</p>
            <div className="mt-2 space-y-1.5 text-sm">
              {attributedByModel.map((row) => (
                <div key={`${row.model}-${row.isByok}`} className="flex justify-between">
                  <span className="text-muted-foreground">
                    {row.model}
                    {row.isByok && <span className="ml-1 text-xs opacity-60">BYOK</span>}
                  </span>
                  <span className="text-muted-foreground">{formatModelUsage(row)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
import { getPortalUrl, getSubscriptionInfo, type SubscriptionInfo } from "./api";

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
  const searchParams = useSearchParams();
  const upgradeIntent = searchParams.get("upgrade");
  const [showPricingDialog, setShowPricingDialog] = useState(Boolean(upgradeIntent));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscriptionInfo, setSubscriptionInfo] = useState<SubscriptionInfo | null>(null);

  const currentPlanConfig = PLANS[currentPlan];
  const aiUsage = currentUsage?.ai;
  const rcaUsage = currentUsage?.rca;
  const detectorUsage = currentUsage?.detector;
  const eventQuota = EVENT_QUOTAS[currentPlan];
  const aiRunQuota = AI_RUN_QUOTAS[currentPlan];
  const rcaRunQuota = RCA_RUN_QUOTAS[currentPlan];
  const detectorRunQuota = DETECTOR_RUN_QUOTAS[currentPlan];

  // Fetch live subscription info from Stripe
  useEffect(() => {
    if (!hasSubscription) return;

    getSubscriptionInfo(workspaceId)
      .then(setSubscriptionInfo)
      .catch((err) => {
        console.error("Failed to fetch subscription info:", err);
      });
  }, [workspaceId, hasSubscription]);

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
          {currentUsage ? (
            <>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Traces</span>
                  <span>{currentUsage.traces.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Spans</span>
                  <span>{currentUsage.spans.toLocaleString()}</span>
                </div>
                <div className="-mx-4 flex justify-between border-t px-4 pt-2">
                  <span className="font-medium">Total events</span>
                  <span className="font-medium">
                    {(currentUsage.traces + currentUsage.spans).toLocaleString()}
                    {eventQuota.included === Infinity
                      ? ""
                      : ` / ${eventQuota.included.toLocaleString()}`}
                  </span>
                </div>
              </div>
              {currentUsage.updatedAt && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Last updated: {new Date(currentUsage.updatedAt).toLocaleString()}
                </p>
              )}
            </>
          ) : (
            // The snapshot is written by the hourly metering job; until its
            // first run, usage is unknown — not zero.
            <p className="mt-3 text-sm text-muted-foreground">
              Usage has not been computed yet. Counts appear after the first metering run.
            </p>
          )}
        </div>
      </div>

      <UsageSection
        title="Chat Usage"
        runsLabel="Chat Runs"
        runsValue={
          aiRunQuota.included === Infinity
            ? `${aiUsage?.runsUsed ?? 0} (Unlimited)`
            : `${aiUsage?.runsUsed ?? 0} / ${aiRunQuota.included}`
        }
        runsHelper={
          "Each chat request." +
          (currentPlan !== PlanType.FREE && currentPlan !== PlanType.ENTERPRISE
            ? ` Overage: ${aiRunQuota.overageLabel}.`
            : "")
        }
        systemCost={aiUsage?.systemUsage.cost ?? 0}
        systemHelper={
          currentPlan === PlanType.FREE
            ? "Included in your plan (we pay)."
            : "Included with runs; 1.05x markup on overage token cost."
        }
        systemInputTokens={aiUsage?.systemUsage.inputTokens ?? 0}
        systemOutputTokens={aiUsage?.systemUsage.outputTokens ?? 0}
        byModel={aiUsage?.byModel}
      />

      <UsageSection
        title="Detector Usage"
        runsLabel="Detector Runs"
        runsValue={
          detectorRunQuota.included === Infinity
            ? formatDetectorScanLabel(detectorUsage?.scansRun ?? 0)
            : `${detectorUsage?.scansRun ?? 0} / ${detectorRunQuota.included}`
        }
        runsHelper="Each detector scan."
        systemCost={detectorUsage?.systemTokenCost ?? 0}
        systemHelper="Usage based."
        systemInputTokens={detectorUsage?.systemInputTokens ?? 0}
        systemOutputTokens={detectorUsage?.systemOutputTokens ?? 0}
        byModel={detectorUsage?.byModel}
      />

      <UsageSection
        title="Root Cause Analysis Usage"
        runsLabel="Root Cause Analysis Runs"
        runsValue={formatRcaQuotaLabel(rcaRunQuota, rcaUsage?.runsUsed ?? 0)}
        runsHelper={
          "Triggered by detector findings." +
          (currentPlan !== PlanType.FREE && currentPlan !== PlanType.ENTERPRISE
            ? ` Overage: ${rcaRunQuota.overageLabel}.`
            : "")
        }
        systemCost={rcaUsage?.systemTokenCost ?? 0}
        systemHelper={
          currentPlan === PlanType.FREE
            ? "Included in your plan (we pay)."
            : "Included with runs; 1.05x markup on overage token cost."
        }
        systemInputTokens={rcaUsage?.systemInputTokens ?? 0}
        systemOutputTokens={rcaUsage?.systemOutputTokens ?? 0}
        byModel={rcaUsage?.byModel}
      />

      {/* Pricing Dialog */}
      <PricingDialog
        open={showPricingDialog}
        onOpenChange={setShowPricingDialog}
        workspaceId={workspaceId}
        currentPlan={currentPlan}
        hasSubscription={hasSubscription}
      />
    </div>
  );
}
