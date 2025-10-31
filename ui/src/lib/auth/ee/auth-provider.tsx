"use client";

import React, { useMemo } from "react";
import { ClerkProvider, useUser, useClerk } from "@clerk/nextjs";
import type { AuthUser, AuthContextValue, AuthProviderProps } from "../types";

/**
 * Enterprise Edition: Real Clerk authentication provider
 * Wraps ClerkProvider and adapts it to our AuthContextValue interface
 */
export function ClerkAuthProvider({ children }: AuthProviderProps) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  return (
    <ClerkProvider
      appearance={{
        baseTheme: undefined,
      }}
      publishableKey={publishableKey}
    >
      {children}
    </ClerkProvider>
  );
}

/**
 * Hook to access Clerk auth with adapted interface
 */
export function useClerkAuth(): AuthContextValue {
  const { user: clerkUser, isLoaded } = useUser();
  const { signOut: clerkSignOut, getToken: clerkGetToken } = useClerk();

  const user: AuthUser | null = useMemo(() => {
    if (!clerkUser) return null;

    return {
      id: clerkUser.id,
      email: clerkUser.emailAddresses[0]?.emailAddress || null,
      firstName: clerkUser.firstName,
      lastName: clerkUser.lastName,
    };
  }, [clerkUser]);

  const signOut = async () => {
    await clerkSignOut();
  };

  const getToken = async () => {
    return await clerkGetToken();
  };

  return {
    user,
    isLoaded,
    isAuthenticated: !!user,
    signOut,
    getToken,
  };
}
