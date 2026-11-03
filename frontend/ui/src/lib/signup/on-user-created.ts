// Everything that follows a new account (demo workspace access, Resend contact,
// welcome email, Slack notice), run from better-auth's user.create.after hook.
// When the address still has to be verified, the welcome and Slack notice wait
// for onEmailVerified instead, so unproven addresses never get mail or a
// notice. Each arm is on only when its own config is set and never rejects. The
// contact is created before the welcome because Resend delivers topic mail to
// non-contacts, and the opt-out needs a record.
import { prisma } from "@traceroot/core";
import { ensureContact, isProductMailConfigured } from "@traceroot/core/email";
import { env } from "@/env";
import { sendWelcomeEmail } from "@/lib/email/welcome/send-welcome-email";
import { ensureDemoMembership } from "@/lib/demo-workspace";
import { findPostHogPerson } from "./posthog-person";
import { notifySignupSlack } from "./notify-slack";
import { isSelfSignup } from "./attribution";

export interface CreatedUser {
  id: string;
  email: string;
  name: string | null;
}

export function signupProvider(path: string | undefined): string {
  if (!path) return "unknown";
  if (path.includes("/sign-up/email")) return "email";
  const social = /\/callback\/([a-z0-9-]+)/i.exec(path);
  return social ? social[1].toLowerCase() : "unknown";
}

async function arm<T>(
  label: string,
  userId: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    console.error(`[signup] ${label} failed for user ${userId}:`, error);
    return undefined;
  }
}

export async function onUserCreated(
  user: CreatedUser,
  context: { path?: string } | null,
  options: { awaitingVerification?: boolean } = {},
): Promise<void> {
  // Every account can look at the demo workspace, however it was created.
  const demo = ensureDemoMembership(user.id);

  // A user provisioned by staff through the admin plugin is not a sign-up, and
  // an unverified one is not announced until onEmailVerified.
  if (!isSelfSignup(context) || options.awaitingVerification) {
    await demo;
    return;
  }

  await Promise.all([demo, announceSignup(user, signupProvider(context?.path))]);
}

// Verification is not only the tail of a fresh sign-up: an account that was
// unverified before verification became required (the grandfather migration
// skips @traceroot.ai, and self-hosts may turn mail on later) is sent a link on
// its next sign-in. Those were never held back, so only an account young
// enough to be a new sign-up is announced. The links themselves expire in 24h.
export const ANNOUNCE_ON_VERIFY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The deferred half of onUserCreated, run once the address is proven. */
export async function onEmailVerified(
  user: CreatedUser & { createdAt: Date },
  now: Date = new Date(),
): Promise<void> {
  if (now.getTime() - user.createdAt.getTime() > ANNOUNCE_ON_VERIFY_MAX_AGE_MS) return;
  // Only email sign-ups wait for verification; OAuth accounts arrive verified.
  await announceSignup(user, "email");
}

async function announceSignup(user: CreatedUser, provider: string): Promise<void> {
  const welcome = isProductMailConfigured()
    ? arm("welcome email", user.id, async () => {
        const contact = await arm("resend contact", user.id, () =>
          ensureContact({ email: user.email, name: user.name }),
        );
        if (!contact?.ok) {
          console.warn(`[signup] welcome email skipped for user ${user.id}: contact not recorded`);
          return;
        }
        return sendWelcomeEmail({ userId: user.id, email: user.email, name: user.name });
      })
    : undefined;

  const slack = env.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL?.trim()
    ? arm("slack", user.id, async () => {
        const [invite, facts, totalUsers] = await Promise.all([
          arm("invite lookup", user.id, () =>
            prisma.invite.findFirst({
              where: { email: { equals: user.email, mode: "insensitive" } },
              select: { id: true },
            }),
          ),
          findPostHogPerson(user.id),
          arm("user count", user.id, () => prisma.user.count()),
        ]);
        return notifySignupSlack({
          name: user.name,
          email: user.email,
          provider,
          viaInvite: invite != null,
          facts,
          supportConsoleUrl: `${env.NEXT_PUBLIC_APP_URL}/admin`,
          totalUsers,
        });
      })
    : undefined;

  await Promise.all([welcome, slack]);
}
