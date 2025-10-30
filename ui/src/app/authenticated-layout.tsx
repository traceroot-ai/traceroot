"use client";

import { useMemo, useEffect } from "react";
import AppSidebar from "@/components/side-bar/Sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AutumnProvider } from "autumn-js/react";
import AuthGuard from "@/components/auth/AuthGuard";
import SubscriptionGuard from "@/components/auth/SubscriptionGuard";
import { useAuth } from "@/lib/auth";

export default function AuthenticatedLayout({
  children,
  isPublicRoute = false,
}: {
  children: React.ReactNode;
  isPublicRoute?: boolean;
}) {
  const { user, isLoaded, isAuthenticated } = useAuth();

  // Determine if user is authenticated - memoize based on user ID only
  // This prevents AutumnProvider from re-rendering on token refresh (every 60s)
  const isAuthenticatedMemo = useMemo(
    () => isLoaded && isAuthenticated,
    [isLoaded, user?.id], // Only depend on user.id, not the whole user object
  );

  // Memoize customerData to prevent new object creation on every render
  const customerData = useMemo(
    () => (isAuthenticatedMemo ? undefined : {}),
    [isAuthenticatedMemo],
  );

  // Create a stable key for AutumnProvider based on user ID
  // This prevents AutumnProvider from unmounting/remounting on token refresh
  const autumnKey = useMemo(
    () => (user?.id ? `autumn-${user.id}` : "autumn-guest"),
    [user?.id],
  );

  // ALWAYS render the same component structure (for consistent hooks)
  return (
    <AuthGuard isPublicRoute={isPublicRoute}>
      <AutumnProvider
        key={autumnKey}
        includeCredentials={isAuthenticatedMemo}
        customerData={customerData}
      >
        <SubscriptionGuard isPublicRoute={isPublicRoute}>
          {isPublicRoute ? (
            // For public routes, just render children
            children
          ) : (
            // For protected routes, wrap with sidebar
            <SidebarProvider defaultOpen={false}>
              <AppSidebar />
              <SidebarInset>{children}</SidebarInset>
            </SidebarProvider>
          )}
        </SubscriptionGuard>
      </AutumnProvider>
    </AuthGuard>
  );
}
