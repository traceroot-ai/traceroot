"use client";

import { useMemo } from "react";
import AppSidebar from "@/components/side-bar/Sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AutumnProvider } from "autumn-js/react";
import AuthGuard from "@/components/auth/AuthGuard";
import SubscriptionGuard from "@/components/auth/SubscriptionGuard";
import { useUser } from "@clerk/nextjs";

const LOCAL_MODE = process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

export default function AuthenticatedLayout({
  children,
  isPublicRoute = false,
}: {
  children: React.ReactNode;
  isPublicRoute?: boolean;
}) {
  // Always call useUser to satisfy hooks rules
  const { user: clerkUser, isLoaded: clerkIsLoaded } = useUser();

  // In self-host mode, override with mock values
  const user = LOCAL_MODE ? { id: "local-user" } : clerkUser;
  const isLoaded = LOCAL_MODE ? true : clerkIsLoaded;

  // Determine if user is authenticated - memoize based on user ID only
  // This prevents AutumnProvider from re-rendering on Clerk token refresh (every 60s)
  const isAuthenticated = useMemo(
    () => LOCAL_MODE || (isLoaded && !!user),
    [isLoaded, user?.id], // Only depend on user.id, not the whole user object
  );

  // Memoize customerData to prevent new object creation on every render
  const customerData = useMemo(
    () => (isAuthenticated ? undefined : {}),
    [isAuthenticated],
  );

  // Create a stable key for AutumnProvider based on user ID
  // This prevents AutumnProvider from unmounting/remounting on Clerk token refresh
  const autumnKey = useMemo(
    () => (user?.id ? `autumn-${user.id}` : "autumn-guest"),
    [user?.id],
  );

  // Content to render (with or without Autumn provider)
  const content = (
    <SubscriptionGuard isPublicRoute={isPublicRoute}>
      {isPublicRoute ? (
        // For public routes, just render children
        children
      ) : (
        // For protected routes, wrap with sidebar
        <SidebarProvider defaultOpen={true}>
          <AppSidebar />
          <SidebarInset>{children}</SidebarInset>
        </SidebarProvider>
      )}
    </SubscriptionGuard>
  );

  // In self-host mode, skip AutumnProvider entirely
  return (
    <AuthGuard isPublicRoute={isPublicRoute}>
      {LOCAL_MODE ? (
        content
      ) : (
        <AutumnProvider
          key={autumnKey}
          includeCredentials={isAuthenticated}
          customerData={customerData}
        >
          {content}
        </AutumnProvider>
      )}
    </AuthGuard>
  );
}
