import type { GenericEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth/api";

/** The error code a refused sign-up carries to /auth/error. */
export const UNVERIFIED_EMAIL_CODE = "email_not_verified";

/**
 * Refuses to create an account from a GitHub sign-in whose email GitHub has not
 * verified. GitHub returns an account's primary address whether or not its
 * owner has confirmed it, and parts of the app trust an account's email as
 * proof of ownership (a workspace invite is accepted by matching it), so an
 * unverified address must never become one. Google, the other built-in
 * provider, only returns verified addresses; AgentID is checked by its own
 * provider. An existing GitHub account still signs in.
 */
export async function refuseUnverifiedGitHubSignUp(
  user: { emailVerified?: boolean | null },
  context: GenericEndpointContext | null,
): Promise<void> {
  if (context?.params?.id !== "github" || user.emailVerified) return;
  throw new APIError("FORBIDDEN", {
    code: UNVERIFIED_EMAIL_CODE,
    message: "Verify this email address on GitHub, then sign in again.",
  });
}
