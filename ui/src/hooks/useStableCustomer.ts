"use client";

import { useRef, useEffect } from "react";
import { useCustomer } from "autumn-js/react";

/**
 * Wraps useCustomer to prevent the customer data from resetting to 'pending'
 * when AutumnProvider re-initializes (e.g., on Clerk token refresh)
 */
export function useStableCustomer(params?: Parameters<typeof useCustomer>[0]) {
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
