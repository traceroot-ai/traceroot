import { LOCAL_USER_CONSTANTS } from "@/lib/constants/auth";
import type { ServerAuthResult, ServerAuthHeaders } from "./types";

/**
 * Community Edition: Mock server authentication
 * Returns mock auth headers for development/self-hosted deployments
 * Used when NEXT_PUBLIC_DISABLE_AUTH=true
 */

export async function getAuthTokenAndHeaders(
  request: Request,
): Promise<ServerAuthResult | null> {
  return {
    userSecret: "mock-secret-token",
    userId: LOCAL_USER_CONSTANTS.USER_ID,
    userEmail: LOCAL_USER_CONSTANTS.USER_EMAIL,
  };
}

export async function createBackendAuthHeaders(): Promise<ServerAuthHeaders> {
  return {
    "Content-Type": "application/json",
    "x-clerk-user-id": LOCAL_USER_CONSTANTS.USER_ID,
    "x-clerk-user-email": LOCAL_USER_CONSTANTS.USER_EMAIL,
  };
}

export function createFetchHeaders(
  authResult: ServerAuthResult,
  additionalHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...additionalHeaders,
  };

  if (authResult.userId && authResult.userEmail) {
    headers["x-clerk-user-id"] = authResult.userId;
    headers["x-clerk-user-email"] = authResult.userEmail;
  }

  return headers;
}
