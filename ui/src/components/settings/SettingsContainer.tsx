"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useAuth } from "@clerk/nextjs";
import { toast } from "react-hot-toast";
import { useStableCustomer } from "@/hooks/useStableCustomer";
import { SettingsSidebar } from "./SettingsSidebar";
import { AccessLostWarning } from "./AccessLostWarning";
import { TokenUsageCard, LocalTokenUsageCard } from "./TokenUsageCard";
import { TracesLogsCard, LocalTracesLogsCard } from "./TracesLogsCard";
import { CurrentPlanCard, LocalCurrentPlanCard } from "./CurrentPlanCard";
import {
  AccountActionsCard,
  LocalAccountActionsCard,
} from "./AccountActionsCard";
import { PaymentHistoryCard } from "./PaymentHistoryCard";
import { TraceProviderTabContent } from "./TraceProviderTabContent";
import { LogProviderTabContent } from "./LogProviderTabContent";
import { APP_VERSION } from "@/constants/version";

export function SettingsContainer() {
  const isLocalMode = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

  const router = useRouter();

  // Always call hooks to maintain consistent hook order
  const { user: clerkUser, isLoaded: clerkLoaded } = useUser();
  const { getToken } = useAuth();

  // Map Clerk user to legacy user format
  const rawUser = clerkUser
    ? {
        email: clerkUser.emailAddresses?.[0]?.emailAddress,
        user_id: clerkUser.id,
      }
    : null;
  const rawUserLoading = !clerkLoaded;
  const rawGetAuthState = async () => await getToken();

  const {
    customer: rawCustomer,
    isLoading: rawCustomerLoading,
    error: rawCustomerError,
    openBillingPortal: rawOpenBillingPortal,
  } = useStableCustomer();

  // Track if we've loaded customer data at least once
  const hasLoadedOnce = useRef(false);

  useEffect(() => {
    if (rawCustomer && !hasLoadedOnce.current) {
      hasLoadedOnce.current = true;
    }
  }, [rawCustomer]);

  // Override values when payment is disabled
  const user = isLocalMode ? null : rawUser;
  const userLoading = isLocalMode ? false : rawUserLoading;
  const getAuthState = isLocalMode ? () => null : rawGetAuthState;
  const customer = isLocalMode ? null : rawCustomer;
  // Only show loading on initial load, not on background refreshes
  const customerLoading = isLocalMode
    ? false
    : rawCustomerLoading && !hasLoadedOnce.current;
  const customerError = isLocalMode ? null : rawCustomerError;
  const openBillingPortal = isLocalMode ? async () => {} : rawOpenBillingPortal;

  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "usage" | "plan" | "trace-provider" | "log-provider"
  >("trace-provider");

  // Mock data for local mode
  const mockTokenUsage = {
    limit: 1_000_000,
    usage: 120_000,
    remaining: 880_000,
    percentage: 12,
  };
  const mockTracesUsage = {
    limit: 100_000,
    usage: 8_500,
    remaining: 91_500,
    percentage: 8.5,
  };

  const isLoading = isLocalMode ? false : userLoading || customerLoading;

  const getLLMTokenInfo = () => {
    if (!customer?.features?.llm_tokens) {
      return { limit: 0, usage: 0, remaining: 0, percentage: 0 };
    }
    const llmTokenFeature = customer.features.llm_tokens;
    const limit = llmTokenFeature.included_usage || 0;
    const usage = llmTokenFeature.usage || 0;
    const remaining = llmTokenFeature.balance || 0;
    const percentage = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
    return { limit, usage, remaining, percentage };
  };

  function getTracesAndLogsInfo() {
    // Directly read from Autumn customer data - no backend fetch needed
    const tracesAndLogsFeature = customer?.features?.trace__log;
    if (!tracesAndLogsFeature) {
      return null;
    }
    const limit = tracesAndLogsFeature.included_usage || 0;
    const usage = tracesAndLogsFeature.usage || 0;
    const remaining = tracesAndLogsFeature.balance || 0;
    const percentage = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
    return { limit, usage, remaining, percentage, isLoading: false };
  }

  // Format numbers with commas for better readability
  const formatNumber = (num: number) => {
    return new Intl.NumberFormat("en-US").format(num);
  };

  // Get color based on usage percentage
  const getUsageColor = (percentage: number) => {
    return percentage >= 100 ? "text-red-600" : "text-green-600";
  };

  const getCurrentPlan = () => {
    if (!customer?.products || customer.products.length === 0) {
      return "Free";
    }

    // Find the currently active product (including trialing status)
    const activeProduct = customer.products.find(
      (product) => product.status === "active" || product.status === "trialing",
    );

    return activeProduct?.name || "Free";
  };

  const hasActiveSubscription = () => {
    if (!customer?.products || customer.products.length === 0) {
      return false;
    }

    return customer.products.some(
      (product) => product.status === "active" || product.status === "trialing",
    );
  };

  const isOnTrial = () => {
    if (!customer?.products || customer.products.length === 0) {
      return false;
    }

    return customer.products.some((product) => product.status === "trialing");
  };

  const getTrialEndDate = () => {
    if (!customer?.products || customer.products.length === 0) {
      return null;
    }

    const trialProduct = customer.products.find(
      (product) => product.status === "trialing",
    );

    // Check multiple possible field names for trial end date
    return (
      trialProduct?.trial_ends_at || trialProduct?.current_period_end || null
    );
  };

  // Capitalize the plan name for display
  const formatPlanName = (plan: string | null | undefined) => {
    if (!plan) return "Free";
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  };

  const handleManageBilling = async () => {
    if (!user?.email) {
      toast.error("Please sign in to manage billing");
      return;
    }
    try {
      setIsProcessing(true);
      toast.loading("Redirecting to billing portal...", {
        id: "billing-redirect",
      });

      await openBillingPortal({
        returnUrl: `${window.location.origin}/settings`,
      });

      toast.dismiss("billing-redirect");
      toast.success("Redirecting to billing portal...");
    } catch (error) {
      toast.dismiss("billing-redirect");

      // More specific error messages
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";

      if (
        errorMessage.includes("configuration") ||
        errorMessage.includes("portal")
      ) {
        toast.error(
          "Billing portal is not configured yet. Please contact support for subscription management.",
          {
            duration: 6000,
          },
        );
      } else if (errorMessage.includes("customer")) {
        toast.error(
          "Unable to find your billing information. Please contact support.",
        );
      } else {
        toast.error(
          "Failed to open billing portal. Please try again or contact support.",
        );
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const getSubscriptionStatus = () => {
    if (!customer) {
      return { status: "Loading...", variant: "secondary" as const };
    }

    if (!hasActiveSubscription()) {
      return { status: "No Subscription", variant: "secondary" as const };
    }

    if (isOnTrial()) {
      return { status: "Trial", variant: "secondary" as const };
    }

    return { status: "Active", variant: "default" as const };
  };

  const currentPlan = getCurrentPlan();
  const subscriptionStatus = getSubscriptionStatus();
  const hasAccess = hasActiveSubscription();
  const trialEndDate = getTrialEndDate();

  const getTrialDaysRemaining = () => {
    if (!trialEndDate) return null;
    const now = new Date();
    const endDate = new Date(trialEndDate);
    const diffTime = endDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
  };

  const trialDaysRemaining = getTrialDaysRemaining();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col p-4">
      {/* Container with similar styling to integrate page */}
      <div className="w-full max-w-7xl mx-auto bg-background dark:bg-background m-5 rounded-lg font-mono border-2 border-border overflow-hidden">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <h2 className="scroll-m-20 text-3xl font-semibold">Settings</h2>
          <span className="text-sm text-muted-foreground font-mono">
            {APP_VERSION}
          </span>
        </div>

        {!isLocalMode && (
          <AccessLostWarning customer={customer} hasAccess={hasAccess} />
        )}

        <div className="flex min-h-[600px]">
          <SettingsSidebar activeTab={activeTab} onTabChange={setActiveTab} />

          {activeTab === "usage" && (
            <div className="flex-1 p-6">
              <div className="mb-6">
                <h2 className="text-2xl font-semibold mb-2">Usage</h2>
                <p className="text-muted-foreground">
                  Monitor your current usage of LLM tokens and trace logs.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {isLocalMode ? (
                  <>
                    <LocalTokenUsageCard
                      tokenUsage={mockTokenUsage}
                      formatNumber={formatNumber}
                      getUsageColor={getUsageColor}
                    />
                    <LocalTracesLogsCard
                      tracesUsage={mockTracesUsage}
                      formatNumber={formatNumber}
                      getUsageColor={getUsageColor}
                    />
                  </>
                ) : (
                  <>
                    <TokenUsageCard
                      tokenInfo={getLLMTokenInfo()}
                      formatNumber={formatNumber}
                      getUsageColor={getUsageColor}
                    />
                    <TracesLogsCard
                      tracesLogsInfo={getTracesAndLogsInfo()}
                      formatNumber={formatNumber}
                      getUsageColor={getUsageColor}
                    />
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === "plan" && (
            <div className="flex-1 p-6">
              <div className="mb-6">
                <h2 className="text-2xl font-semibold mb-2">Plan</h2>
                <p className="text-muted-foreground">
                  Manage your current plan, billing information, and account
                  actions.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                {isLocalMode ? (
                  <>
                    <LocalCurrentPlanCard planName="Free" status="N/A" />
                    <LocalAccountActionsCard />
                  </>
                ) : (
                  <>
                    <CurrentPlanCard
                      currentPlan={currentPlan}
                      subscriptionStatus={subscriptionStatus}
                      customer={customer}
                      isOnTrial={isOnTrial}
                      trialDaysRemaining={trialDaysRemaining}
                      formatPlanName={formatPlanName}
                    />
                    <AccountActionsCard
                      isOnTrial={isOnTrial}
                      handleManageBilling={handleManageBilling}
                      isProcessing={isProcessing}
                      user={user}
                    />
                    <PaymentHistoryCard customer={customer} />
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === "trace-provider" && <TraceProviderTabContent />}

          {activeTab === "log-provider" && <LogProviderTabContent />}
        </div>
      </div>
    </div>
  );
}
