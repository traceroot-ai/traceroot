import { auth } from "@clerk/nextjs/server";
import { LOCAL_USER } from "./self-host-constants";

const DISABLE_PAYMENT = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

export interface ClerkAuthResult {
  userSecret: string;
  clerkUserId: string | null;
  clerkUserEmail: string | null;
}

/**
 * Get authentication token and user info for Clerk users
 * In self-host mode (DISABLE_PAYMENT=true), returns mock local user data
 */
export async function getAuthTokenAndHeaders(
  _request: Request,
): Promise<ClerkAuthResult | null> {
  // Self-host mode: return mock local user
  if (DISABLE_PAYMENT) {
    return {
      userSecret: LOCAL_USER.USER_SECRET,
      clerkUserId: LOCAL_USER.USER_ID,
      clerkUserEmail: LOCAL_USER.USER_EMAIL,
    };
  }

  let userSecret: string | null = null;
  let clerkUserId: string | null = null;
  let clerkUserEmail: string | null = null;

  // Get Clerk authentication
  try {
    const { userId, getToken } = await auth();
    if (userId) {
      userSecret = await getToken();
      clerkUserId = userId;

      // Get user email from Clerk
      const { clerkClient } = await import("@clerk/nextjs/server");
      const client = await clerkClient();
      const user = await client.users.getUser(userId);
      clerkUserEmail = user.emailAddresses[0]?.emailAddress || null;
    }
  } catch (clerkError) {
    console.log("Clerk auth not available");
    return null;
  }

  if (!userSecret) {
    return null;
  }

  return {
    userSecret,
    clerkUserId,
    clerkUserEmail,
  };
}

/**
 * Create fetch headers with authentication and Clerk user info
 */
export function createFetchHeaders(
  authResult: ClerkAuthResult,
  additionalHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authResult.userSecret}`,
    ...additionalHeaders,
  };

  // Add Clerk user info headers if available
  if (authResult.clerkUserId && authResult.clerkUserEmail) {
    headers["x-clerk-user-id"] = authResult.clerkUserId;
    headers["x-clerk-user-email"] = authResult.clerkUserEmail;
  }

  return headers;
}
