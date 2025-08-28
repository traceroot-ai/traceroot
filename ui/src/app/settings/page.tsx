"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  FaCreditCard,
  FaHistory,
  FaCrown,
  FaRobot,
  FaChartLine,
} from "react-icons/fa";
import { useUser } from "../../hooks/useUser";
import { useCustomer } from "autumn-js/react";
import { toast } from "react-hot-toast";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function SettingsPage() {
  const router = useRouter();
  const { user, isLoading: userLoading, getAuthState } = useUser();
  const {
    customer,
    isLoading: customerLoading,
    error: customerError,
    openBillingPortal,
  } = useCustomer();

  const [isProcessing, setIsProcessing] = useState(false);
  const [tracesAndLogsData, setTracesAndLogsData] = useState(null);
  const [isLoadingTracesAndLogs, setIsLoadingTracesAndLogs] = useState(true);

  const isLoading = userLoading || customerLoading;

  // Get LLM token information from Autumn customer data
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

  // Get traces and logs information from Autumn customer data
  function getTracesAndLogsInfo() {
    // If still loading, show loading state
    if (isLoadingTracesAndLogs) {
      return {
        limit: 0,
        usage: 0,
        remaining: 0,
        percentage: 0,
        isLoading: true,
      };
    }

    // Use API data if available, fallback to Autumn data
    const tracesAndLogsFeature = customer?.features?.trace__log;

    if (!tracesAndLogsFeature) {
      return null;
    }

    const limit = tracesAndLogsFeature.included_usage || 0;
    const usage = tracesAndLogsFeature.usage || 0; // This now contains fresh data from API
    const remaining = tracesAndLogsFeature.balance || 0;
    const percentage = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;

    return { limit, usage, remaining, percentage, isLoading: false };
  }

  // Fetch traces and logs usage from backend API
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

        // Update customer data with fresh usage info
        if (customer?.features?.trace__log && data.traces_and_logs) {
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
  }, [customer, isLoading]);

  // Format numbers with commas for better readability
  const formatNumber = (num: number) => {
    return new Intl.NumberFormat("en-US").format(num);
  };

  // Get color based on usage percentage
  const getUsageColor = (percentage: number) => {
    if (percentage >= 90) return "text-destructive";
    if (percentage >= 75) return "text-yellow-600 dark:text-yellow-400";
    return "text-green-600 dark:text-green-400";
  };

  // Get current active product from Autumn customer data
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

  // Check if customer has active subscription
  const hasActiveSubscription = () => {
    if (!customer?.products || customer.products.length === 0) {
      return false;
    }

    return customer.products.some(
      (product) => product.status === "active" || product.status === "trialing",
    );
  };

  // Check if customer is on trial
  const isOnTrial = () => {
    if (!customer?.products || customer.products.length === 0) {
      return false;
    }

    return customer.products.some((product) => product.status === "trialing");
  };

  // Get trial end date if on trial
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

  // Handle manage billing click using Autumn's openBillingPortal
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

  // Get subscription status based on Autumn customer data
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

  // Calculate trial days remaining
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
      <div className="w-3/4 max-w-4xl mx-auto bg-background dark:bg-background m-5 p-10 rounded-lg font-mono border border-border shadow-sm">
        <h2 className="scroll-m-20 mb-5 text-3xl font-semibold first:mt-0">
          Settings
        </h2>
        <p className="leading-7 [&:not(:first-child)]:mb-5">
          Manage your account settings and subscription preferences.
        </p>

        {/* Access Lost Warning */}
        {customer && !hasAccess && (
          <Card className="mb-6 border-destructive bg-destructive/5">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0">
                  <svg
                    className="h-5 w-5 text-destructive"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-destructive">
                    Subscription Access Lost
                  </h3>
                  <p className="mt-2 text-sm text-destructive/80">
                    Your subscription has expired or been cancelled. You no
                    longer have access to premium features. To restore access,
                    please upgrade your subscription.
                  </p>
                  <div className="mt-4">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => router.push("/pricing")}
                    >
                      Upgrade Now
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 p-3">
          {/* Subscription Status Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center space-x-2.5">
                <FaCrown className="text-foreground" size={20} />
                <CardTitle className="font-semibold text-sm">
                  CURRENT PLAN
                </CardTitle>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Plan Details - Structured Layout */}
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">
                      Plan Name
                    </div>
                    <div className="text-sm font-medium mt-1">
                      {formatPlanName(currentPlan)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">
                      Status
                    </div>
                    <div className="text-sm font-medium mt-1">
                      {subscriptionStatus.status}
                    </div>
                  </div>
                </div>

                {customer?.products && customer.products.length > 0 && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wide">
                        Start Date
                      </div>
                      <div className="text-sm font-medium mt-1">
                        {(() => {
                          if (!customer.created_at) return "N/A";

                          try {
                            const date = new Date(customer.created_at);
                            if (isNaN(date.getTime())) {
                              return "N/A";
                            }
                            return date.toLocaleDateString("en-US", {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                            });
                          } catch (error) {
                            return "N/A";
                          }
                        })()}
                      </div>
                    </div>
                    {isOnTrial() && trialDaysRemaining !== null && (
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">
                          Trial Remaining
                        </div>
                        <div className="text-sm font-medium mt-1">
                          {trialDaysRemaining} days
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* LLM Token Usage Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center space-x-2.5">
                <FaRobot className="text-foreground" size={20} />
                <CardTitle className="font-semibold text-sm">
                  LLM TOKEN USAGE
                </CardTitle>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {(() => {
                const tokenInfo = getLLMTokenInfo();

                if (tokenInfo.limit === 0 && tokenInfo.remaining === 0) {
                  return (
                    <div className="text-center py-4">
                      <div className="text-sm text-muted-foreground">
                        No LLM token quota configured
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Contact support to set up LLM token tracking
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    {/* Usage Progress Bar */}
                    {tokenInfo.limit > 0 && (
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-xs text-muted-foreground uppercase tracking-wide">
                            This Month
                          </span>
                          <span
                            className={`text-xs font-medium ${getUsageColor(tokenInfo.percentage)}`}
                          >
                            {tokenInfo.percentage.toFixed(1)}% used
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2">
                          <div
                            className={`h-2 rounded-full transition-all duration-300 ${
                              tokenInfo.percentage >= 90
                                ? "bg-destructive"
                                : tokenInfo.percentage >= 75
                                  ? "bg-yellow-500 dark:bg-yellow-600"
                                  : "bg-green-500 dark:bg-green-600"
                            }`}
                            style={{
                              width: `${Math.min(100, tokenInfo.percentage)}%`,
                            }}
                          ></div>
                        </div>
                      </div>
                    )}

                    {/* Token Statistics */}
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">
                          Used
                        </div>
                        <div className="text-sm font-medium mt-1">
                          {formatNumber(tokenInfo.usage)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">
                          Remaining
                        </div>
                        <div
                          className={`text-sm font-medium mt-1 ${getUsageColor(tokenInfo.percentage)}`}
                        >
                          {formatNumber(tokenInfo.remaining)}
                        </div>
                      </div>
                      {/* <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">
                          Total
                        </div>
                        <div className="text-sm font-medium mt-1">
                          {formatNumber(tokenInfo.limit)}
                        </div>
                      </div> */}
                    </div>

                    {/* Warning for high usage */}
                    {tokenInfo.percentage >= 80 && (
                      <div
                        className={`text-xs p-2 rounded border ${
                          tokenInfo.percentage >= 90
                            ? "bg-destructive/10 text-destructive border-destructive/20 dark:bg-destructive/5 dark:text-destructive dark:border-destructive/10"
                            : "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-300 dark:border-yellow-500/20"
                        }`}
                      >
                        {tokenInfo.percentage >= 90
                          ? "⚠️ You're running low on LLM tokens. Consider upgrading your plan."
                          : "💡 You've used most of your LLM tokens this month."}
                      </div>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          {/* Traces and Logs Usage Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center space-x-2.5">
                <FaChartLine className="text-foreground" size={20} />
                <CardTitle className="font-semibold text-sm">
                  TRACES & LOGS USAGE
                </CardTitle>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {(() => {
                const tracesLogsInfo = getTracesAndLogsInfo();

                if (tracesLogsInfo === null) {
                  return (
                    <div className="text-center py-4">
                      <div className="text-sm text-muted-foreground">
                        No traces & logs quota configured
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Contact support to set up traces & logs tracking
                      </div>
                    </div>
                  );
                }

                if (tracesLogsInfo.isLoading) {
                  return (
                    <div className="text-center py-4">
                      <div className="text-sm text-muted-foreground">
                        Loading traces & logs usage...
                      </div>
                    </div>
                  );
                }

                if (
                  tracesLogsInfo.limit === 0 &&
                  tracesLogsInfo.remaining === 0
                ) {
                  return (
                    <div className="text-center py-4">
                      <div className="text-sm text-muted-foreground">
                        No traces & logs quota configured
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Contact support to set up traces & logs tracking
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    {/* Usage Progress Bar */}
                    {tracesLogsInfo.limit > 0 && (
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-xs text-muted-foreground uppercase tracking-wide">
                            This Month
                          </span>
                          <span
                            className={`text-xs font-medium ${getUsageColor(tracesLogsInfo.percentage)}`}
                          >
                            {tracesLogsInfo.percentage.toFixed(1)}% used
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2">
                          <div
                            className={`h-2 rounded-full transition-all duration-300 ${
                              tracesLogsInfo.percentage >= 90
                                ? "bg-destructive"
                                : tracesLogsInfo.percentage >= 75
                                  ? "bg-yellow-500 dark:bg-yellow-600"
                                  : "bg-green-500 dark:bg-green-600"
                            }`}
                            style={{
                              width: `${Math.min(100, tracesLogsInfo.percentage)}%`,
                            }}
                          ></div>
                        </div>
                      </div>
                    )}

                    {/* Traces & Logs Statistics */}
                    <div className="grid grid-cols-2 gap-4 text-center">
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">
                          Used
                        </div>
                        <div className="text-sm font-medium mt-1">
                          {formatNumber(tracesLogsInfo.usage)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">
                          Remaining
                        </div>
                        <div
                          className={`text-sm font-medium mt-1 ${getUsageColor(tracesLogsInfo.percentage)}`}
                        >
                          {formatNumber(tracesLogsInfo.remaining)}
                        </div>
                      </div>
                    </div>

                    {/* Warning for high usage */}
                    {tracesLogsInfo.percentage >= 80 && (
                      <div
                        className={`text-xs p-2 rounded border ${
                          tracesLogsInfo.percentage >= 90
                            ? "bg-destructive/10 text-destructive border-destructive/20 dark:bg-destructive/5 dark:text-destructive dark:border-destructive/10"
                            : "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-300 dark:border-yellow-500/20"
                        }`}
                      >
                        {tracesLogsInfo.percentage >= 90
                          ? "⚠️ You're running low on traces & logs quota. Consider upgrading your plan."
                          : "💡 You've used most of your traces & logs quota this month."}
                      </div>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          {/* Quick Actions Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center space-x-2.5">
                <FaCreditCard className="text-foreground" size={24} />
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-sm font-semibold">
                    Account Actions
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Manage your subscription and billing
                  </CardDescription>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              <Button
                onClick={() => router.push("/pricing")}
                className="w-full"
                variant={isOnTrial() ? "default" : "outline"}
              >
                {isOnTrial() ? "Upgrade Plan" : "Change Plan"}
              </Button>

              {user?.email && (
                <Button
                  onClick={handleManageBilling}
                  disabled={isProcessing}
                  className="w-full gap-2"
                  variant="secondary"
                >
                  <FaCreditCard size={16} />
                  {isProcessing ? "Opening..." : "Manage Billing"}
                </Button>
              )}

              <p className="text-xs text-muted-foreground text-center">
                Update payment methods, view invoices, and manage your
                subscription
              </p>
            </CardContent>
          </Card>

          {/* Payment History Card - Using Autumn customer invoices if available */}
          {customer?.invoices && customer.invoices.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center space-x-2.5">
                  <FaHistory className="text-foreground" size={20} />
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base font-semibold">
                      RECENT PAYMENTS
                    </CardTitle>
                    <CardDescription className="text-sm">
                      Your recent payment history
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <CardContent>
                <div className="space-y-3">
                  {customer.invoices
                    .slice(-3)
                    .reverse()
                    .map((invoice: any, index) => (
                      <div
                        key={invoice.id || invoice.stripe_id || index}
                        className="flex items-center justify-between py-2 border-b border-border last:border-b-0"
                      >
                        <div className="text-sm font-medium">
                          $
                          {(
                            (invoice.amount_paid || invoice.amount || 0) / 100
                          ).toFixed(2)}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {invoice.created
                            ? new Date(
                                invoice.created * 1000,
                              ).toLocaleDateString()
                            : invoice.date
                              ? new Date(invoice.date).toLocaleDateString()
                              : "N/A"}
                        </div>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
