/**
 * Unified auth exports
 * Automatically selects between Community Edition (mock) and Enterprise Edition (Clerk)
 * based on NEXT_PUBLIC_DISABLE_AUTH environment variable
 */

const IS_AUTH_DISABLED =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
  process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

// Try to use EE (Clerk) implementation, fallback to CE (mock)
let AuthProvider: any;
let useAuth: any;

if (IS_AUTH_DISABLED) {
  // Community Edition: Use mock auth
  const ceAuth = require("./auth-provider");
  AuthProvider = ceAuth.LocalAuthProvider;
  useAuth = ceAuth.useLocalAuth;
  console.log("✅ Auth: Using Community Edition (Mock Auth)");
} else {
  // Enterprise Edition: Use Clerk auth
  try {
    const eeAuth = require("./ee/auth-provider");
    AuthProvider = eeAuth.ClerkAuthProvider;
    useAuth = eeAuth.useClerkAuth;
    console.log("✅ Auth: Using Enterprise Edition (Clerk Auth)");
  } catch (error) {
    // Fallback to CE if EE not available
    const ceAuth = require("./auth-provider");
    AuthProvider = ceAuth.LocalAuthProvider;
    useAuth = ceAuth.useLocalAuth;
    console.log(
      "⚠️  Auth: EE not available, falling back to Community Edition",
    );
  }
}

export { AuthProvider, useAuth };

// Re-export types
export type {
  AuthUser,
  AuthContextValue,
  AuthProviderProps,
  ServerAuthResult,
  ServerAuthHeaders,
} from "./types";
