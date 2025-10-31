import { auth, currentUser } from "@clerk/nextjs/server";
import type { ServerAuthResult, ServerAuthHeaders } from "../types";

/**
 * Enterprise Edition: Real Clerk server authentication
 * Uses Clerk's auth() and currentUser() for real authentication
 */

export async function getAuthTokenAndHeaders(
  request: Request,
): Promise<ServerAuthResult | null> {
  let userSecret: string | null = null;
  let userId: string | null = null;
  let userEmail: string | null = null;

  try {
    const { userId: clerkUserId, getToken } = await auth();
    if (clerkUserId) {
      userSecret = await getToken();
      userId = clerkUserId;

      const { clerkClient } = await import("@clerk/nextjs/server");
      const client = await clerkClient();
      const user = await client.users.getUser(clerkUserId);
      userEmail = user.emailAddresses[0]?.emailAddress || null;
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
    userId,
    userEmail,
  };
}

export async function createBackendAuthHeaders(): Promise<ServerAuthHeaders> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  const user = await currentUser();

  if (!user) {
    throw new Error("User not found");
  }

  const userEmail = user.emailAddresses[0]?.emailAddress;

  if (!userEmail) {
    throw new Error("User email not found");
  }

  return {
    "Content-Type": "application/json",
    "x-clerk-user-id": userId,
    "x-clerk-user-email": userEmail,
  };
}

export function createFetchHeaders(
  authResult: ServerAuthResult,
  additionalHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authResult.userSecret}`,
    ...additionalHeaders,
  };

  if (authResult.userId && authResult.userEmail) {
    headers["x-clerk-user-id"] = authResult.userId;
    headers["x-clerk-user-email"] = authResult.userEmail;
  }

  return headers;
}
