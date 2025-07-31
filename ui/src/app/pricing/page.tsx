'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/hooks/useUser';
import { useUserSubscription } from '@/hooks/useUserSubscription';
import { redirectToCheckout } from '@/utils/stripe';
import { PLAN_FEATURES, PLAN_PRICES, SubscriptionPlan } from '@/types/subscription';
import { toast } from 'react-hot-toast';
import { shouldShowPaymentFeatures } from '@/utils/stripe-config';

function PricingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useUser();
  const { subscription, currentPlan, hasActiveSubscription, isLoading: subscriptionLoading } = useUserSubscription();
  const [processing, setProcessing] = useState(false);

  const showPaymentFeatures = shouldShowPaymentFeatures();

  useEffect(() => {
    // Redirect to home if Stripe is not configured
    if (!showPaymentFeatures) {
      router.push('/');
      return;
    }
  }, [showPaymentFeatures, router]);

  useEffect(() => {
    // Check for canceled payment
    if (searchParams?.get('canceled')) {
      toast.error('Payment canceled.');
    }
  }, [searchParams]);

  // Don't render anything if Stripe is not configured
  if (!showPaymentFeatures) {
    return null;
  }

  const handleSubscribe = async (plan: SubscriptionPlan) => {
    if (!user) {
      toast.error('Please sign in to subscribe');
      router.push('/login');
      return;
    }

    if (!user.email) {
      toast.error('User email not found');
      return;
    }

    try {
      setProcessing(true);
      await redirectToCheckout(plan, user.email);
    } catch (error) {
      console.error('Error during checkout:', error);
      toast.error('Failed to process subscription');
    } finally {
      setProcessing(false);
    }
  };

  // Helper function to check if a plan is the user's current plan
  const isCurrentPlan = (plan: SubscriptionPlan): boolean => {
    return hasActiveSubscription && currentPlan === plan;
  };

  // Helper function to get button text and styling
  const getButtonProps = (plan: SubscriptionPlan) => {
    const isUserCurrentPlan = isCurrentPlan(plan);
    const baseClassName = 'mt-8 block w-full rounded-md px-4 py-2 text-center text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50';

    if (isUserCurrentPlan) {
      if (subscription?.is_trial && plan === 'starter') {
        return {
          text: 'Activate Paid Plan',
          onClick: () => handleSubscribe(plan),
          disabled: processing || isLoading || subscriptionLoading,
          className: `${baseClassName} bg-green-500 text-white hover:bg-green-600`,
        };
      }
      return {
        text: 'Current Plan',
        onClick: () => {}, // No action for current plan
        disabled: true,
        className: 'mt-8 block w-full rounded-md bg-gray-400 px-4 py-2 text-center text-sm font-semibold text-gray-600 cursor-not-allowed',
      };
    }

    if (plan === 'pro') {
      return {
        text: processing ? 'Processing...' : 'Get Started',
        onClick: () => handleSubscribe(plan),
        disabled: processing || isLoading || subscriptionLoading,
        className: `${baseClassName} bg-green-500 text-white hover:bg-green-600`,
      };
    }

    return {
      text: processing ? 'Processing...' : 'Get Started',
      onClick: () => handleSubscribe(plan),
      disabled: processing || isLoading || subscriptionLoading,
      className: `${baseClassName} bg-gray-800 text-white hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600`,
    };
  };

  return (
    <div className="min-h-screen bg-gray-50 py-12 dark:bg-gray-900">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
            Pricing
          </h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-300">
            Choose the plan that works for you
          </p>
          <p className="mt-2 text-base text-gray-500 dark:text-gray-400">
            All plans include access to our platform, lead generation tools, and dedicated support.
          </p>
        </div>

        <div className="mt-16 grid gap-8 lg:grid-cols-3">
          {/* Starter Plan */}
          <div className={`relative rounded-lg border bg-white p-8 shadow-sm dark:bg-gray-800 ${
            isCurrentPlan('starter')
              ? 'border-green-500 ring-2 ring-green-500 ring-opacity-50'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            {isCurrentPlan('starter') && subscription?.is_trial && (
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-blue-500 px-4 py-1 text-sm font-semibold text-white">
                Trial Plan ({subscription.trial_days_remaining} days left)
              </div>
            )}
            {isCurrentPlan('starter') && !subscription?.is_trial && (
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-green-500 px-4 py-1 text-sm font-semibold text-white">
                Your Plan
              </div>
            )}
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Starter</h2>
            <p className="mt-8">
              <span className="text-4xl font-bold text-gray-900 dark:text-white">${PLAN_PRICES.starter}</span>
              <span className="text-base font-medium text-gray-500 dark:text-gray-400">/month</span>
            </p>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              You can optionally cancel and get money back for the first 7 days free trial period
            </p>
            <ul className="mt-8 space-y-4">
              {PLAN_FEATURES.starter.map((feature, index) => (
                <li key={index} className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg className="h-6 w-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="ml-3 text-sm text-gray-700 dark:text-gray-300">{feature}</p>
                </li>
              ))}
            </ul>
            {(() => {
              const buttonProps = getButtonProps('starter');
              return (
                <button
                  onClick={buttonProps.onClick}
                  disabled={buttonProps.disabled}
                  className={buttonProps.className}
                >
                  {buttonProps.text}
                </button>
              );
            })()}
          </div>

          {/* Pro Plan */}
          <div className={`relative rounded-lg border bg-white p-8 shadow-sm dark:bg-gray-800 ${
            isCurrentPlan('pro')
              ? 'border-green-500 ring-2 ring-green-500 ring-opacity-50'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-green-500 px-4 py-1 text-sm font-semibold text-white">
              {isCurrentPlan('pro') ? 'Your Plan' : 'Popular'}
            </div>
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Pro</h2>
            <p className="mt-8">
              <span className="text-4xl font-bold text-gray-900 dark:text-white">${PLAN_PRICES.pro}</span>
              <span className="text-base font-medium text-gray-500 dark:text-gray-400">/month</span>
            </p>
            <ul className="mt-8 space-y-4">
              {PLAN_FEATURES.pro.map((feature, index) => (
                <li key={index} className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg className="h-6 w-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="ml-3 text-sm text-gray-700 dark:text-gray-300">{feature}</p>
                </li>
              ))}
            </ul>
            {(() => {
              const buttonProps = getButtonProps('pro');
              return (
                <button
                  onClick={buttonProps.onClick}
                  disabled={buttonProps.disabled}
                  className={buttonProps.className}
                >
                  {buttonProps.text}
                </button>
              );
            })()}
          </div>

          {/* Startups Plan */}
          <div className={`rounded-lg border bg-white p-8 shadow-sm dark:bg-gray-800 ${
            isCurrentPlan('startups')
              ? 'border-green-500 ring-2 ring-green-500 ring-opacity-50'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            {isCurrentPlan('startups') && (
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-green-500 px-4 py-1 text-sm font-semibold text-white">
                Your Plan
              </div>
            )}
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Startups</h2>
            <p className="mt-8">
              <span className="text-4xl font-bold text-gray-900 dark:text-white">${PLAN_PRICES.startups}</span>
              <span className="text-base font-medium text-gray-500 dark:text-gray-400">/month</span>
            </p>
            <ul className="mt-8 space-y-4">
              {PLAN_FEATURES.startups.map((feature, index) => (
                <li key={index} className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg className="h-6 w-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="ml-3 text-sm text-gray-700 dark:text-gray-300">{feature}</p>
                </li>
              ))}
            </ul>
            {(() => {
              const buttonProps = getButtonProps('startups');
              return (
                <button
                  onClick={buttonProps.onClick}
                  disabled={buttonProps.disabled}
                  className={buttonProps.className}
                >
                  {buttonProps.text}
                </button>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

// Main page component with Suspense
export default function PricingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto mb-4"></div>
          <p className="text-gray-700 dark:text-gray-300">Loading pricing information...</p>
        </div>
      </div>
    }>
      <PricingContent />
    </Suspense>
  );
}
