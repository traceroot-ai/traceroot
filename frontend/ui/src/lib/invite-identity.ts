import { prisma } from "@traceroot/core";

/** better-auth's provider id for an email-and-password account. */
const PASSWORD_PROVIDER_ID = "credential";

/**
 * Whether this account's email address can stand as proof that the person is
 * the one an invite was sent to. An invite is matched by email alone, so the
 * address must have been confirmed: verified by a sign-in provider (Google, or
 * GitHub with an address GitHub verified), or the one the person signed up with
 * using a password, as accounts have always been able to. An account made by a
 * sign-in that did not confirm its address cannot accept an invite with it.
 */
export async function inviteEmailIsProven(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true, accounts: { select: { providerId: true } } },
  });
  if (!user) return false;
  if (user.emailVerified) return true;
  return user.accounts.some((account) => account.providerId === PASSWORD_PROVIDER_ID);
}
