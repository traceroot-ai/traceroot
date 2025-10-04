"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "../../hooks/useUser";
import { useCustomer } from "autumn-js/react";
import { toast } from "react-hot-toast";
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
import { CloudProviderTabContent } from "./CloudProviderTabContent";
import { APP_VERSION } from "@/constants/version";

export function SettingsContainer() {
  const isLocalMode = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

  const router = useRouter();
  const {
    user,
    isLoading: userLoading,
    getAuthState,
  } = isLocalMode
    ? { user: null, isLoading: false, getAuthState: () => null }
    : useUser();
  const {
    customer,
    isLoading: customerLoading,
    error: customerError,
    openBillingPortal,
  } = isLocalMode
    ? {
        customer: null,
        isLoading: false,
        error: null,
        openBillingPortal: async () => {},
      }
    : useCustomer();

  const [isProcessing, setIsProcessing] = useState(false);
  const [tracesAndLogsData, setTracesAndLogsData] = useState<any>(null);
  const [isLoadingTracesAndLogs, setIsLoadingTracesAndLogs] = useState(true);
  const [activeTab, setActiveTab] = useState<"usage" | "plan" | "provider">(
    "provider",
  );

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
    if (isLoadingTracesAndLogs) {
      return {
        limit: 0,
        usage: 0,
        remaining: 0,
        percentage: 0,
        isLoading: true,
      };
    }
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

  const fetchTracesAndLogsUsage = async () => {
    try {
      setIsLoadingTracesAndLogs(true);
      const authState = getAuthState();

      if (!authState || !customer?.products) {
        setIsLoadingTracesAndLogs(false);
        return;
      }

      // Get the last payment date from customer subscription
      const activeProduct = customer.products.find(
        (product) =>
          product.status === "active" || product.status === "trialing",
      );
      if (!activeProduct) {
        setIsLoadingTracesAndLogs(false);
        return;
      }

      const sinceDate = activeProduct.current_period_start
        ? new Date(activeProduct.current_period_start).toISOString()
        : new Date().toISOString(); // Fallback to current date

      // Use GET with query parameters
      const url = new URL(
        "/api/get_traces_and_logs_usage",
        window.location.origin,
      );
      console.log("sinceDate", sinceDate);
      url.searchParams.set("since_date", sinceDate);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${authState}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setTracesAndLogsData(data.traces_and_logs);

        if (customer?.features?.trace__log && data.traces_and_logs) {
          // update in-memory usage for display
          customer.features.trace__log.usage = data.traces_and_logs.trace__log;
        }
      }
    } catch (error) {
      console.error("Error fetching traces and logs usage:", error);
    } finally {
      setIsLoadingTracesAndLogs(false);
    }
  };

  // TODO (xinwei): properly fix this please, right now it is reloading
  // whenever we go to another page and back which is not ideal
  // useEffect to fetch data when customer is loaded
  useEffect(() => {
    if (customer && !isLoading) {
      fetchTracesAndLogsUsage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, isLoading]);

  // Format numbers with commas for better readability
  const formatNumber = (num: number) => {
    return new Intl.NumberFormat("en-US").format(num);
  };

  // Get color based on usage percentage
  const getUsageColor = (percentage: number) => {
    return percentage >= 100 ? "text-red-600" : "text-green-600";
  };

  const getCurrentPlan = () => {
    console.log("customer", customer);
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

    // Debug: log the trial product to see available fields
    if (trialProduct) {
      console.log("Trial product:", trialProduct);
      console.log("Trial product keys:", Object.keys(trialProduct));
    }

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
      console.error("Error opening billing portal:", error);
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

          {activeTab === "provider" && <CloudProviderTabContent />}
        </div>
      </div>
    </div>
  );
}
