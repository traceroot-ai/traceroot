'use client';

import { useState, useEffect } from 'react';
import { useUser } from './useUser';

interface UserSubscription {
  user_email: string;
  hasAccess: boolean;
  subscription_plan: string;
  start_date: string;
  is_trial: boolean;
  trial_start_date?: string;
  trial_days_remaining?: number;
  payment_history: Array<{
    amount: number;
    date: string;
    stripe_payment_id: string;
  }>;
}

export function useUserSubscription() {
  const { user } = useUser();
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSubscription = async () => {
    if (!user?.email) {
      console.log('[Subscription Hook] No user email, skipping fetch');
      setSubscription(null);
      setIsLoading(false);
      return;
    }

    try {
      const backendUrl = process.env.NEXT_PUBLIC_REST_API_ENDPOINT || 'http://localhost:8000';
      const url = `${backendUrl}/v1/subscriptions/get?user_email=${encodeURIComponent(user.email)}`;
      console.log('[Subscription Hook] Fetching subscription from:', url);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        // Add cache: 'no-store' to prevent caching
        cache: 'no-store'
      });

      console.log('[Subscription Hook] Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Subscription Hook] Failed to fetch subscription:', errorText);
        throw new Error(`Failed to fetch subscription: ${errorText}`);
      }

      const data = await response.json();
      console.log('[Subscription Hook] Received raw response:', data);

      // Extract subscription data from the response
      const subscriptionData = data.subscription;
      console.log('[Subscription Hook] Extracted subscription data:', subscriptionData);

      if (!subscriptionData) {
        console.log('[Subscription Hook] No subscription data found in response');
        setSubscription(null);
      } else {
        setSubscription(subscriptionData);
      }
      setError(null);
    } catch (err) {
      console.error('[Subscription Hook] Error fetching subscription:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch subscription'));
      setSubscription(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch on mount and when user email changes
  useEffect(() => {
    console.log('[Subscription Hook] User email changed, fetching subscription');
    fetchSubscription();
  }, [user?.email]);

  // Add polling to periodically check for updates
  useEffect(() => {
    if (!user?.email) return;

    const pollInterval = setInterval(() => {
      console.log('[Subscription Hook] Polling for subscription updates');
      fetchSubscription();
    }, 5000); // Poll every 5 seconds

    return () => clearInterval(pollInterval);
  }, [user?.email]);

  const refetch = async () => {
    console.log('[Subscription Hook] Manual refetch triggered');
    setIsLoading(true);
    await fetchSubscription();
  };

  // Extract values from subscription data with proper logging
  const currentPlan = subscription?.subscription_plan;
  const hasActiveSubscription = subscription?.hasAccess ?? false;

  console.log('[Subscription Hook] Returning values:', {
    currentPlan,
    hasActiveSubscription,
    subscription
  });

  return {
    subscription,
    isLoading,
    error,
    refetch,
    hasActiveSubscription,
    currentPlan,
  };
}
