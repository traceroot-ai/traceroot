"use client";

import { useCustomer } from "autumn-js/react";

const DISABLE_PAYMENT = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

export function useSubscription() {
  // Only use useCustomer hook when payment is not disabled
  const customerData = DISABLE_PAYMENT
    ? { customer: null, isLoading: false, error: null }
    : useCustomer();

  const { customer, isLoading, error } = customerData;

  // Log payment status for debugging
  if (DISABLE_PAYMENT) {
    console.log("Payment is disabled - using mock subscription data");
  } else {
    console.log("Payment is enabled - using real subscription data");
  }

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
      (product) => product.status === "active" || product.status === "trialing"
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
      (product) => product.status === "active" || product.status === "trialing"
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

    return customer.products.some((product) => product.status === "trialing");
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
