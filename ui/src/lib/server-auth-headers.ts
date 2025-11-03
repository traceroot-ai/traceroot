import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * Helper to create backend API headers with proper authentication
 * Used by API routes to authenticate with the REST backend
 * Call this from your API route handler (SERVER SIDE ONLY)
 */
export async function createBackendAuthHeaders(): Promise<
  Record<string, string>
> {
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
