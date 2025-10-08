"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useCustomer } from "autumn-js/react";
import { useUser } from "@clerk/nextjs";

interface SubscriptionGuardProps {
  children: React.ReactNode;
  isPublicRoute?: boolean;
}

// Routes that don't require subscription
const publicRoutes = ["/auth/auth-callback", "/pricing"];

const DISABLE_PAYMENT = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

// Inner component that uses Autumn hooks
function SubscriptionGuardInner({
  children,
  isPublicRoute = false,
}: {
  children: React.ReactNode;
  isPublicRoute?: boolean;
}) {
  const { user, isLoaded } = useUser();
  const router = useRouter();
  const pathname = usePathname();

  // User is authenticated if they're logged in with Clerk
  const userLoading = !isLoaded;

  // Call useCustomer hook (only called when wrapped in AutumnProvider)
  const {
    customer: rawCustomer,
    isLoading: rawCustomerLoading,
    error: rawCustomerError,
  } = useCustomer();

  // Override customer data when payment is disabled
  const customer = DISABLE_PAYMENT ? null : rawCustomer;
  const customerLoading = DISABLE_PAYMENT ? false : rawCustomerLoading;
  const customerError = DISABLE_PAYMENT ? null : rawCustomerError;

  const isLoading = userLoading || customerLoading;

  // Check if user has an active subscription
  const hasActiveSubscription = () => {
    const userEmail = user?.emailAddresses?.[0]?.emailAddress;
    console.log(
      "🔍 SubscriptionGuard - Checking subscription for user:",
      userEmail,
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
    const userEmail = user?.emailAddresses?.[0]?.emailAddress;
    console.log("🔍 SubscriptionGuard useEffect triggered");
    console.log("🔍 SubscriptionGuard - DISABLE_PAYMENT:", DISABLE_PAYMENT);
    console.log("🔍 SubscriptionGuard - userLoading:", userLoading);
    console.log("🔍 SubscriptionGuard - customerLoading:", customerLoading);
    console.log("🔍 SubscriptionGuard - isLoading:", isLoading);
    console.log("🔍 SubscriptionGuard - customer:", customer);
    console.log(
      "🔍 SubscriptionGuard - customer?.products:",
      customer?.products,
    );
    console.log("🔍 SubscriptionGuard - pathname:", pathname);
    console.log("🔍 SubscriptionGuard - user:", userEmail);
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

    // Wait for customer data: if customer is null without error, or if customer is "pending", we're still loading
    if ((!customer && !customerError) || customer?.id === "pending") {
      console.log(
        "🔍 SubscriptionGuard - Customer data not loaded yet, waiting...",
      );
      return;
    }

    // Check subscription status and redirect if needed
    const hasSubscription = hasActiveSubscription();

    if (!hasSubscription) {
      console.log(
        "❌ SubscriptionGuard - No active subscription, redirecting to pricing",
      );
      router.push("/pricing");
    } else {
      console.log("✅ SubscriptionGuard - User has active subscription");
    }
  }, [
    user,
    customer,
    customerError,
    isLoading,
    customerLoading,
    userLoading,
    pathname,
    router,
  ]);

  // If payment is disabled or public route, always allow access
  if (DISABLE_PAYMENT || isPublicRoute) {
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

  // Allow access to public routes (pathname-based check)
  if (publicRoutes.includes(pathname)) {
    return <>{children}</>;
  }

  // If user is not authenticated, let AuthGuard handle it
  if (!user) {
    return <>{children}</>;
  }

  // Show loading while customer data is being fetched (including "pending" state)
  if ((!customer && !customerError) || customer?.id === "pending") {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  // Now we have stable data - check subscription and show loading while redirecting if needed
  if (customerError || !hasActiveSubscription()) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return <>{children}</>;
}

// Outer wrapper component
export default function SubscriptionGuard({
  children,
  isPublicRoute = false,
}: SubscriptionGuardProps) {
  // ALWAYS render SubscriptionGuardInner for consistent hooks
  // Pass isPublicRoute so it can skip subscription logic
  return (
    <SubscriptionGuardInner isPublicRoute={isPublicRoute}>
      {children}
    </SubscriptionGuardInner>
  );
}
