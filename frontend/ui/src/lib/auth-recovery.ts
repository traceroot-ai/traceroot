import { APIError, createAuthMiddleware } from "better-auth/api";
import { AGENTID_PROVIDER_ID } from "@/lib/social-providers";

/** better-auth's own provider id for the email-and-password sign-in. */
const PASSWORD_PROVIDER_ID = "credential";

interface LinkedAccount {
  id: string;
  providerId: string;
}

/** Said when a reset is refused; the same for every such account. */
export const RESET_NOT_AVAILABLE =
  "This account can't be reset with a link. Please contact support to recover it.";

/**
 * The sign-in identities whose ownership a reset link cannot settle. A reset
 * proves the person holds the mailbox; an identity that never proved it could
 * belong to whoever registered the address first, and would keep a way in
 * after the owner set a password.
 *
 * - On an account whose address was never verified, nothing but a password
 *   proved it, so every other identity is unproven.
 * - AgentID always reports its address unverified, so an AgentID identity is
 *   unproven on any account.
 *
 * Identities a verified account linked under the linking rules in lib/auth.ts,
 * and the password itself, are proven.
 */
export function unprovenIdentities(
  user: { emailVerified: boolean },
  accounts: LinkedAccount[],
): LinkedAccount[] {
  return accounts.filter(
    (account) =>
      account.providerId !== PASSWORD_PROVIDER_ID &&
      (!user.emailVerified || account.providerId === AGENTID_PROVIDER_ID),
  );
}

/**
 * Runs before better-auth's `POST /reset-password` and only reads. With a
 * valid, unexpired token for an account that has an unproven identity, it
 * refuses the reset, so nothing about that account changes and recovery goes
 * through support. Every other request (no token, an unknown or expired one,
 * a password-only account, a verified account's proven identities) goes on to
 * the endpoint unchanged, which validates the password and applies the reset
 * in its own transaction.
 */
export const refuseResetWithUnprovenIdentities = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/reset-password") return;
  const body = ctx.body as { token?: unknown } | undefined;
  const query = ctx.query as { token?: unknown } | undefined;
  const token = body?.token ?? query?.token;
  if (typeof token !== "string" || !token) return;

  const adapter = ctx.context.internalAdapter;
  const verification = await adapter.findVerificationValue(`reset-password:${token}`);
  if (!verification || verification.expiresAt < new Date()) return;
  const user = await adapter.findUserById(verification.value);
  if (!user) return;

  if (unprovenIdentities(user, await adapter.findAccounts(user.id)).length > 0) {
    throw new APIError("FORBIDDEN", { message: RESET_NOT_AVAILABLE });
  }
});
