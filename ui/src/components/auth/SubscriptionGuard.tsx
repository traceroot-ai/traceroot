"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useStableCustomer } from "@/hooks/useStableCustomer";

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

  // Call useStableCustomer hook (only called when wrapped in AutumnProvider)
  const {
    customer: rawCustomer,
    isLoading: rawCustomerLoading,
    error: rawCustomerError,
  } = useStableCustomer();

  // Track if we've loaded customer data at least once to prevent loading screen on tab switch
  const hasLoadedOnce = useRef(false);
  const prevCustomerId = useRef<string | null | undefined>(undefined);

  if (rawCustomer && !hasLoadedOnce.current) {
    hasLoadedOnce.current = true;
  }

  // Track customer ID changes
  useEffect(() => {
    if (rawCustomer?.id !== prevCustomerId.current) {
      prevCustomerId.current = rawCustomer?.id;
    }
  }, [rawCustomer?.id, rawCustomerLoading]);

  // Override customer data when payment is disabled
  const customer = DISABLE_PAYMENT ? null : rawCustomer;
  // Only show loading on initial load, not on background refreshes (e.g., tab switch)
  const customerLoading = DISABLE_PAYMENT
    ? false
    : rawCustomerLoading && !hasLoadedOnce.current;
  const customerError = DISABLE_PAYMENT ? null : rawCustomerError;

  const isLoading = userLoading || customerLoading;

  // Check if user has an active subscription
  const hasActiveSubscription = () => {
    if (!customer?.products || customer.products.length === 0) {
      return false;
    }

    return customer.products.some(
      (product: { status: string }) =>
        product.status === "active" || product.status === "trialing",
    );
  };

  useEffect(() => {
    // If payment is disabled, skip subscription checks
    if (DISABLE_PAYMENT) {
      return;
    }

    // Don't redirect if still loading or on public routes
    if (isLoading || publicRoutes.includes(pathname)) {
      return;
    }

    // If user is not authenticated, let AuthGuard handle it
    if (!user) {
      return;
    }

    // Wait for customer data: if customer is null without error, or if customer is "pending", we're still loading
    if ((!customer && !customerError) || customer?.id === "pending") {
      return;
    }

    // Check subscription status and redirect if needed
    if (!hasActiveSubscription()) {
      router.push("/pricing");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    user?.id, // Only depend on user ID, not the whole user object
    customer?.id, // Only depend on customer ID, not the whole customer object
    customerError,
    isLoading,
    pathname,
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
