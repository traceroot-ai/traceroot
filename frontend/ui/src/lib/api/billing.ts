/**
 * Billing API functions
 */
import { fetchNextApi } from "./client";

interface CheckoutResponse {
  url: string;
}

interface ChangePlanResponse {
  success: boolean;
  message: string;
}

interface PortalResponse {
  url: string;
}

export interface SubscriptionInfo {
  cancellation: { cancelAt: string } | null;
  scheduledChange: { switchAt: string; newPlan: string } | null;
  billingPeriod: { start: string; end: string } | null;
}

/**
 * Create a Stripe checkout session for first-time subscription
 */
export async function createCheckoutSession(
  workspaceId: string,
  plan: string,
): Promise<CheckoutResponse> {
  return fetchNextApi<CheckoutResponse>("/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ workspaceId, plan }),
  });
}

/**
 * Change subscription plan (upgrade, downgrade, or cancel to free)
 */
export async function changePlan(
  workspaceId: string,
  newPlan: string,
): Promise<ChangePlanResponse> {
  return fetchNextApi<ChangePlanResponse>("/billing/change-plan", {
    method: "POST",
    body: JSON.stringify({ workspaceId, newPlan }),
  });
}

/**
 * Get Stripe customer portal URL (for invoices, payment methods)
 */
export async function getPortalUrl(workspaceId: string): Promise<PortalResponse> {
  return fetchNextApi<PortalResponse>("/billing/portal", {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });
}

/**
 * Get live subscription info from Stripe (cancellation, scheduled changes, billing period)
 */
export async function getSubscriptionInfo(workspaceId: string): Promise<SubscriptionInfo> {
  return fetchNextApi<SubscriptionInfo>(`/billing/subscription-info?workspaceId=${workspaceId}`, {
    method: "GET",
  });
}
