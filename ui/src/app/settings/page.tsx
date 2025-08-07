'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FaCreditCard, FaHistory, FaCalendarAlt, FaCrown } from 'react-icons/fa';
import { useUser } from '../../hooks/useUser';
import { useUserSubscription } from '../../hooks/useUserSubscription';
import { createPortalSession } from '../../utils/stripe';
import { toast } from 'react-hot-toast';
import { shouldShowPaymentFeatures } from '@/utils/stripe-config';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

export default function SettingsPage() {
  const router = useRouter();
  const { user, isLoading: userLoading } = useUser();
  const {
    subscription,
    currentPlan: currentPlanDisplay,
    hasActiveSubscription,
    isLoading: subscriptionLoading
  } = useUserSubscription();

  const [isProcessing, setIsProcessing] = useState(false);

  const isLoading = userLoading || subscriptionLoading;
  const showPaymentFeatures = shouldShowPaymentFeatures();

  useEffect(() => {
    // Redirect to home if Stripe is not configured
    if (!showPaymentFeatures) {
      router.push('/');
      return;
    }
  }, [showPaymentFeatures, router]);

  // Don't render anything if Stripe is not configured
  if (!showPaymentFeatures) {
    return null;
  }

  // Format the date nicely
  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (e) {
      console.error('Error formatting date:', e);
      return 'Invalid Date';
    }
  };

  // Capitalize the plan name for display
  const formatPlanName = (plan: string | null | undefined) => {
    if (!plan) return 'None';
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  };

  // Handle manage billing click
  const handleManageBilling = async () => {
    if (!user?.email) {
      toast.error('Please sign in to manage billing');
      return;
    }

    try {
      setIsProcessing(true);
      toast.loading('Redirecting to billing portal...', { id: 'billing-redirect' });

      const portalUrl = await createPortalSession(user.email);

      toast.dismiss('billing-redirect');
      toast.success('Redirecting to billing portal...');

      // Redirect to Stripe Customer Portal
      window.location.href = portalUrl;
    } catch (error) {
      console.error('Error opening billing portal:', error);
      toast.dismiss('billing-redirect');

      // More specific error messages
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      if (errorMessage.includes('configuration') || errorMessage.includes('portal')) {
        toast.error('Billing portal is not configured yet. Please contact support for subscription management.', {
          duration: 6000,
        });
      } else if (errorMessage.includes('customer')) {
        toast.error('Unable to find your billing information. Please contact support.');
      } else {
        toast.error('Failed to open billing portal. Please try again or contact support.');
      }
    } finally {
      setIsProcessing(false);
    }
  };

  // Get badge variant based on plan type
  const getPlanBadgeVariant = (plan: string) => {
    switch (plan.toLowerCase()) {
      case 'pro':
        return 'default';
      case 'startups':
        return 'secondary';
      case 'starter':
        return 'outline';
      default:
        return 'outline';
    }
  };

  // Get subscription status
  const getSubscriptionStatus = () => {
    if (!subscription) return { status: 'No Subscription', variant: 'secondary' as const };

    if (!subscription.hasAccess) {
      return { status: 'Expired', variant: 'destructive' as const };
    }

    if (subscription.is_trial) {
      return { status: 'Trial', variant: 'secondary' as const };
    }

    return { status: 'Active', variant: 'default' as const };
  };

  const subscriptionStatus = getSubscriptionStatus();

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
      <div className="w-3/4 max-w-4xl mx-auto bg-white m-5 p-10 rounded-lg font-mono bg-zinc-50">
        <h2 className="scroll-m-20 mb-5 text-3xl font-semibold first:mt-0">
          Settings
        </h2>
        <p className="leading-7 [&:not(:first-child)]:mb-5">
          Manage your account settings and subscription preferences.
        </p>

        {/* Access Lost Warning */}
        {subscription && !subscription.hasAccess && (
          <Card className="mb-6 border-destructive bg-destructive/5">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-destructive" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-destructive">
                    Subscription Access Lost
                  </h3>
                  <p className="mt-2 text-sm text-destructive/80">
                    Your subscription has expired or been cancelled. You no longer have access to premium features.
                    To restore access, please upgrade your subscription.
                  </p>
                  <div className="mt-4">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => router.push('/pricing')}
                    >
                      Upgrade Now
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 p-3">
          {/* Subscription Status Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center space-x-2.5">
                <FaCrown className="text-foreground" size={20} />
                <CardTitle className="text-base font-semibold">CURRENT PLAN</CardTitle>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Plan Details - Structured Layout */}
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Plan Name</div>
                    <div className="text-sm font-medium mt-1">{formatPlanName(currentPlanDisplay)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Status</div>
                    <div className="text-sm font-medium mt-1">{subscriptionStatus.status}</div>
                  </div>
                </div>

                {subscription && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wide">Start Date</div>
                      <div className="text-sm font-medium mt-1">{formatDate(subscription.start_date)}</div>
                    </div>
                    {subscription.is_trial && (
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">Trial Remaining</div>
                        <div className="text-sm font-medium mt-1">
                          {subscription.trial_days_remaining} days
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Quick Actions Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center space-x-2.5">
                <FaCreditCard className="text-foreground" size={24} />
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-base font-semibold">Account Actions</CardTitle>
                  <CardDescription className="text-sm">
                    Manage your subscription and billing
                  </CardDescription>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              <Button
                onClick={() => router.push('/pricing')}
                className="w-full"
                variant={subscription?.is_trial ? "default" : "outline"}
              >
                {subscription?.is_trial ? 'Upgrade Plan' : 'Change Plan'}
              </Button>

              {user?.email && (
                <Button
                  onClick={handleManageBilling}
                  disabled={isProcessing}
                  className="w-full gap-2"
                  variant="secondary"
                >
                  <FaCreditCard size={16} />
                  {isProcessing ? 'Opening...' : 'Manage Billing'}
                </Button>
              )}

              <p className="text-xs text-muted-foreground text-center">
                Update payment methods, view invoices, and manage your subscription
              </p>
            </CardContent>
          </Card>

          {/* Payment History Card */}
          {subscription?.payment_history && subscription.payment_history.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center space-x-2.5">
                  <FaHistory className="text-foreground" size={20} />
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base font-semibold">RECENT PAYMENTS</CardTitle>
                    <CardDescription className="text-sm">
                      Your recent payment history
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <CardContent>
                <div className="space-y-3">
                  {subscription.payment_history.slice(-3).reverse().map((payment, index) => (
                    <div key={payment.stripe_payment_id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
                      <div className="text-sm font-medium">
                        ${(payment.amount / 100).toFixed(2)}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {new Date(payment.date).toLocaleDateString()}
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
