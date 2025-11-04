"use client";

import { useStableCustomer } from "./useStableCustomer";

const DISABLE_PAYMENT = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

export function useSubscription() {
  // Always call useStableCustomer to maintain consistent hook order
  // Override the values when payment is disabled
  const {
    customer: rawCustomer,
    isLoading: rawIsLoading,
    error: rawError,
  } = useStableCustomer();

  const customer = DISABLE_PAYMENT ? null : rawCustomer;
  const isLoading = DISABLE_PAYMENT ? false : rawIsLoading;
  const error = DISABLE_PAYMENT ? null : rawError;

  const hasActiveSubscription = () => {
    // If payment is disabled, always return true to allow access
    if (DISABLE_PAYMENT) {
      return true;
    }

    // Payment is enabled - check real subscription status
    if (!customer?.products || customer.products.length === 0) {
      return false;
    }

    return customer.products.some(
      (product: { status: string }) =>
        product.status === "active" || product.status === "trialing",
    );
  };

  const getCurrentPlan = () => {
    // If payment is disabled, return a mock plan
    if (DISABLE_PAYMENT) {
      return "Development Mode";
    }

    if (!customer?.products || customer.products.length === 0) {
      return "Free";
    }

    // Find the currently active product (including trialing status)
    const activeProduct = customer.products.find(
      (product: { status: string; name: string | null }) =>
        product.status === "active" || product.status === "trialing",
    );

    return activeProduct?.name || "Free";
  };

  const isOnTrial = () => {
    // If payment is disabled, return false
    if (DISABLE_PAYMENT) {
      return false;
    }

    if (!customer?.products || customer.products.length === 0) {
      return false;
    }

    return customer.products.some(
      (product: { status: string }) => product.status === "trialing",
    );
  };

  return {
    customer,
    isLoading,
    error,
    hasActiveSubscription: hasActiveSubscription(),
    getCurrentPlan: getCurrentPlan(),
    isOnTrial: isOnTrial(),
  };
}
