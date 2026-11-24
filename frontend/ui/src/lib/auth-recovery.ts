import { createAuthMiddleware } from "better-auth/api";
import { AGENTID_PROVIDER_ID } from "@/lib/social-providers";

/** better-auth's own provider id for the email-and-password sign-in. */
const PASSWORD_PROVIDER_ID = "credential";

interface LinkedAccount {
  id: string;
  providerId: string;
}

/**
 * The sign-in identities that do not survive a password reset. A valid reset
 * token proves the person holds the mailbox; an identity that never proved it
 * could belong to whoever registered the address first, and would otherwise
 * keep a way in after the owner has recovered the account.
 *
 * - On an account whose address was never verified, nothing but the password
 *   proved it, so every other identity goes.
 * - AgentID always reports its address unverified, so an AgentID identity goes
 *   from any account.
 *
 * Identities a verified account linked under the linking rules in lib/auth.ts
 * stay, and so does the password being reset.
 */
export function identitiesToDropOnReset(
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
 * Runs before better-auth's `POST /reset-password`. With a valid, unexpired
 * token, it drops the identities above and the account's sessions before the
 * new password is set; a failure here stops the reset, leaving the token
 * usable. Anything else (no token, an unknown or expired one) is left to the
 * endpoint, which answers as it always does.
 */
export const dropUnprovenIdentitiesOnReset = createAuthMiddleware(async (ctx) => {
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

  const drop = identitiesToDropOnReset(user, await adapter.findAccounts(user.id));
  if (drop.length === 0) return;
  for (const account of drop) await adapter.deleteAccount(account.id);
  // A session the dropped identity opened ends now, not only when the reset lands.
  await adapter.deleteUserSessions(user.id);
});
