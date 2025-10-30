"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { LOCAL_USER_CONSTANTS } from "@/lib/constants/auth";
import type { AuthUser, AuthContextValue, AuthProviderProps } from "./types";

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoaded: false,
  isAuthenticated: false,
  signOut: async () => {},
});

/**
 * Community Edition: Mock authentication provider
 * Uses localStorage to persist a mock user for development
 * Used when NEXT_PUBLIC_DISABLE_AUTH=true
 */
export function LocalAuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // Auto-create mock user on mount
    const mockUser: AuthUser = {
      id: LOCAL_USER_CONSTANTS.USER_ID,
      email: LOCAL_USER_CONSTANTS.USER_EMAIL,
      firstName: LOCAL_USER_CONSTANTS.USER_FIRST_NAME,
      lastName: LOCAL_USER_CONSTANTS.USER_LAST_NAME,
    };

    setUser(mockUser);
    setIsLoaded(true);
  }, []);

  const signOut = async () => {
    // In mock mode, just reload to "/"
    window.location.href = "/";
  };

  const value: AuthContextValue = {
    user,
    isLoaded,
    isAuthenticated: !!user,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access mock auth context
 */
export function useLocalAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useLocalAuth must be used within LocalAuthProvider");
  }
  return context;
}
