"use client";

import { useRef, useEffect } from "react";
import { useCustomer } from "autumn-js/react";

const DISABLE_PAYMENT = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

/**
 * Wraps useCustomer to prevent the customer data from resetting to 'pending'
 * when AutumnProvider re-initializes (e.g., on Clerk token refresh)
 *
 * In self-host mode, returns mock data without calling Autumn
 */
export function useStableCustomer(params?: Parameters<typeof useCustomer>[0]) {
  // In self-host mode, return mock customer data without calling useCustomer
  if (DISABLE_PAYMENT) {
    return {
      customer: null,
      isLoading: false,
      error: null,
    };
  }

  // In cloud mode, use the real useCustomer hook
  const result = useCustomer({
    ...params,
    swrConfig: {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      dedupingInterval: 60000,
      focusThrottleInterval: 60000,
      ...params?.swrConfig,
    },
  });

  // Cache the last valid (non-pending) customer data
  const cachedCustomer =
    useRef<ReturnType<typeof useCustomer>["customer"]>(null);

  useEffect(() => {
    // If we got real customer data (not pending), cache it
    if (
      result.customer &&
      result.customer.id !== "pending" &&
      !result.isLoading
    ) {
      cachedCustomer.current = result.customer;
    }
  }, [result.customer, result.isLoading]);

  // If current data is 'pending' but we have cached data, use the cache
  const shouldUseCache =
    result.customer?.id === "pending" && cachedCustomer.current !== null;

  if (shouldUseCache) {
    return {
      ...result,
      customer: cachedCustomer.current,
      isLoading: false,
    };
  }

  return result;
}
