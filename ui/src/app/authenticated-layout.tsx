"use client";

import AppSidebar from "@/components/side-bar/Sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AutumnProvider } from "autumn-js/react";
import AuthGuard from "@/components/auth/AuthGuard";
import SubscriptionGuard from "@/components/auth/SubscriptionGuard";
import { useUser } from "@clerk/nextjs";

export default function AuthenticatedLayout({
  children,
  isPublicRoute = false,
}: {
  children: React.ReactNode;
  isPublicRoute?: boolean;
}) {
  const { user, isLoaded } = useUser();

  // Determine if user is authenticated
  const isAuthenticated = isLoaded && !!user;

  // ALWAYS render the same component structure (for consistent hooks)
  return (
    <AuthGuard isPublicRoute={isPublicRoute}>
      <AutumnProvider
        includeCredentials={isAuthenticated}
        customerData={isAuthenticated ? undefined : {}}
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
