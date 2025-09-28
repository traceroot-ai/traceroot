"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useCustomer } from "autumn-js/react";
import { useUser } from "../../hooks/useUser";

interface SubscriptionGuardProps {
  children: React.ReactNode;
}

// Routes that don't require subscription
const publicRoutes = ["/auth/auth-callback", "/pricing"];

const DISABLE_PAYMENT = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

export default function SubscriptionGuard({
  children,
}: SubscriptionGuardProps) {
  const { user, isLoading: userLoading } = useUser();

  // Only use useCustomer hook when payment is not disabled
  const customerData = DISABLE_PAYMENT
    ? { customer: null, isLoading: false, error: null }
    : useCustomer();

  const {
    customer,
    isLoading: customerLoading,
    error: customerError,
  } = customerData;
  const router = useRouter();
  const pathname = usePathname();

  const isLoading = userLoading || customerLoading;

  // Check if user has an active subscription
  const hasActiveSubscription = () => {
    console.log(
      "🔍 SubscriptionGuard - Checking subscription for user:",
      user?.email,
    );
    console.log("🔍 SubscriptionGuard - Customer data:", customer);
    console.log(
      "🔍 SubscriptionGuard - Customer products:",
      customer?.products,
    );

    if (!customer?.products || customer.products.length === 0) {
      console.log("❌ SubscriptionGuard - No products found");
      return false;
    }

    // Log each product's details
    customer.products.forEach((product, index) => {
      console.log(`🔍 SubscriptionGuard - Product ${index}:`, {
        name: product.name,
        status: product.status,
        id: product.id,
      });
    });

    const hasActive = customer.products.some(
      (product) => product.status === "active" || product.status === "trialing",
    );

    console.log("🔍 SubscriptionGuard - Has active subscription:", hasActive);
    console.log(
      "🔍 SubscriptionGuard - Product statuses:",
      customer.products.map((p) => p.status),
    );
    return hasActive;
  };

  useEffect(() => {
    console.log("🔍 SubscriptionGuard useEffect triggered");
    console.log("🔍 SubscriptionGuard - DISABLE_PAYMENT:", DISABLE_PAYMENT);
    console.log("🔍 SubscriptionGuard - isLoading:", isLoading);
    console.log("🔍 SubscriptionGuard - pathname:", pathname);
    console.log("🔍 SubscriptionGuard - user:", user?.email);
    console.log("🔍 SubscriptionGuard - customerError:", customerError);

    // If payment is disabled, skip subscription checks
    if (DISABLE_PAYMENT) {
      console.log("Payment is disabled, skipping subscription checks");
      return;
    }

    // Payment is enabled - enforce subscription checks
    console.log("Payment is enabled, enforcing subscription checks");

    // Don't redirect if still loading or on public routes
    if (isLoading || publicRoutes.includes(pathname)) {
      console.log(
        "🔍 SubscriptionGuard - Skipping redirect (loading or public route)",
      );
      return;
    }

    // If user is not authenticated, let AuthGuard handle it
    if (!user) {
      console.log(
        "🔍 SubscriptionGuard - No user, letting AuthGuard handle it",
      );
      return;
    }

    // If customer data failed to load or user has no active subscription
    if (customerError || !hasActiveSubscription()) {
      console.log(
        "❌ SubscriptionGuard - No active subscription found, redirecting to pricing page",
      );
      console.log("❌ SubscriptionGuard - customerError:", customerError);
      console.log(
        "❌ SubscriptionGuard - hasActiveSubscription():",
        hasActiveSubscription(),
      );
      router.push("/pricing");
    } else {
      console.log(
        "✅ SubscriptionGuard - User has active subscription, allowing access",
      );
    }
  }, [user, customer, customerError, isLoading, pathname, router]);

  // If payment is disabled, always allow access
  if (DISABLE_PAYMENT) {
    return <>{children}</>;
  }

  // Show loading state while checking subscription
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  // Allow access to public routes
  if (publicRoutes.includes(pathname)) {
    return <>{children}</>;
  }

  // If user is not authenticated, let AuthGuard handle it
  if (!user) {
    return <>{children}</>;
  }

  // If customer data failed to load or user has no active subscription, show loading while redirecting
  if (customerError || !hasActiveSubscription()) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return <>{children}</>;
}
