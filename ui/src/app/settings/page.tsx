'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FaUser, FaCreditCard, FaHistory, FaBuilding, FaBriefcase } from 'react-icons/fa';
import { HiMail } from 'react-icons/hi';
import { useUser } from '../../hooks/useUser';
import { useUserSubscription } from '../../hooks/useUserSubscription';
import { createPortalSession } from '../../utils/stripe';
import { toast } from 'react-hot-toast';
import { shouldShowPaymentFeatures } from '@/utils/stripe-config';

export default function SettingsPage() {
  const router = useRouter();
  const { user, avatarLetter, isLoading: userLoading } = useUser();
  const {
    subscription,
    currentPlan: currentPlanDisplay,
    hasActiveSubscription,
    isLoading: subscriptionLoading
  } = useUserSubscription();

  const [isChangeHovered, setIsChangeHovered] = useState(false);
  const [isManageBillingHovered, setIsManageBillingHovered] = useState(false);
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

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto mb-4"></div>
          <p className="text-gray-700">Loading settings...</p>
        </div>
      </div>
    );
  }

  // Default user data when not logged in
  const defaultEmail = "user@example.com";
  const displayEmail = user?.email || defaultEmail;
  const displayAvatarLetter = avatarLetter || displayEmail.charAt(0).toUpperCase();

  // Plan badge color based on plan type - using green, black, white theme
  const getPlanBadgeColor = (plan: string) => {
    switch (plan.toLowerCase()) {
      case 'pro':
        return 'bg-green-100 text-green-800 border-green-300';
      case 'startups':
        return 'bg-black text-white border-gray-800';
      case 'starter':
        return 'bg-gray-100 text-gray-800 border-gray-300';
      case 'n/a':
      default:
        return 'bg-gray-50 text-gray-600 border-gray-200';
    }
  };

  return (
    <div className="min-h-screen bg-white p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-black mb-2">Settings</h1>
          <p className="text-gray-600">Manage your settings</p>
        </div>

        {/* Profile Information Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
              <FaUser className="text-green-600" size={14} />
            </div>
            <h2 className="text-xl font-semibold text-black">Profile Information</h2>
          </div>
          <p className="text-gray-600 mb-6">Your account details and basic information</p>

          <div className="flex items-center gap-4">
            {/* Avatar */}
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center border border-green-200">
              {displayAvatarLetter ? (
                <span className="text-green-600 font-semibold text-xl">
                  {displayAvatarLetter}
                </span>
              ) : (
                <FaUser className="text-green-600" size={24} />
              )}
            </div>

            {/* User Info */}
            <div className="flex flex-col space-y-2">
              {user?.given_name && user?.family_name && (
                <div className="flex items-center gap-2">
                  <FaUser className="text-gray-400" size={20} />
                  <span className="text-black font-medium">{user.given_name} {user.family_name}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <HiMail className="text-gray-400" size={20} />
                <span className="text-black font-medium">{displayEmail}</span>
              </div>
              {user?.company && (
                <div className="flex items-center gap-2">
                  <FaBuilding className="text-gray-400" size={20} />
                  <span className="text-black font-medium">{user.company}</span>
                </div>
              )}
              {user?.title && (
                <div className="flex items-center gap-2">
                  <FaBriefcase className="text-gray-400" size={20} />
                  <span className="text-black font-medium">{user.title}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Account & Subscription Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
              <FaCreditCard className="text-green-600" size={14} />
            </div>
            <h2 className="text-xl font-semibold text-black">Account & Subscription</h2>
          </div>
          <p className="text-gray-600 mb-6">Manage your plan and billing</p>

          <div className="space-y-4">
            {/* Access Lost Warning */}
            {subscription && !subscription.hasAccess && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-red-600" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-800">
                      Subscription Access Lost
                    </h3>
                    <div className="mt-2 text-sm text-red-700">
                      <p>
                        Your subscription has expired or been cancelled. You no longer have access to premium features.
                        To restore access, please upgrade your subscription.
                      </p>
                    </div>
                    <div className="mt-4">
                      <button
                        onClick={() => router.push('/pricing')}
                        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                      >
                        Upgrade Now
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Current Plan */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-black font-medium">Current Plan:</span>
                <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${getPlanBadgeColor(currentPlanDisplay || 'n/a')}`}>
                  {formatPlanName(currentPlanDisplay)}
                </span>
                {subscription?.is_trial ? (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 border border-blue-200">
                    Trial ({subscription.trial_days_remaining} days left)
                  </span>
                ) : hasActiveSubscription && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">
                    Active
                  </span>
                )}
              </div>

              <button
                className="px-6 py-2 bg-black text-white font-medium rounded-lg hover:bg-gray-800 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
                onMouseEnter={() => setIsChangeHovered(true)}
                onMouseLeave={() => setIsChangeHovered(false)}
                onClick={() => router.push('/pricing')}
              >
                {subscription?.is_trial ? 'Upgrade Plan' : 'Change plan'}
              </button>
            </div>

            {/* Subscription Details */}
            {subscription && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-gray-200">
                <div>
                  <p className="text-sm text-gray-500">Subscription Start Date</p>
                  <p className="text-sm font-medium text-black">
                    {formatDate(subscription.start_date)}
                  </p>
                </div>
              </div>
            )}

            {/* Billing Management */}
            {user?.email && (
              <div className="pt-4 border-t border-gray-200">
                <button
                  className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  onMouseEnter={() => setIsManageBillingHovered(true)}
                  onMouseLeave={() => setIsManageBillingHovered(false)}
                  onClick={handleManageBilling}
                  disabled={isProcessing}
                >
                  <FaCreditCard size={16} />
                  {isProcessing ? 'Opening...' : 'Manage Billing'}
                </button>
                <p className="text-xs text-gray-500 mt-2">
                  Update payment methods, view invoices, and manage your subscription
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Payment History Section */}
        {subscription?.payment_history && subscription.payment_history.length > 0 && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
                <FaHistory className="text-green-600" size={14} />
              </div>
              <h2 className="text-xl font-semibold text-black">Recent Payments</h2>
            </div>
            <p className="text-gray-600 mb-6">Your recent payment history</p>

            <div className="space-y-3">
              {subscription.payment_history.slice(-3).reverse().map((payment, index) => (
                <div key={payment.stripe_payment_id} className="flex items-center justify-between py-3 px-4 bg-gray-50 rounded-lg border border-gray-100">
                  <div>
                    <p className="text-sm font-medium text-black">
                      ${(payment.amount / 100).toFixed(2)}
                    </p>
                    <p className="text-xs text-gray-500">
                      {new Date(payment.date).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">
                      Payment ID: {payment.stripe_payment_id.slice(-8)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
