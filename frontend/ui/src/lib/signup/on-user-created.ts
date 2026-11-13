// Everything that follows a new account (demo workspace access, Resend contact,
// welcome email, Slack notice), run from better-auth's user.create.after hook.
// Each arm is on only when its own config is set and never rejects. The
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

export interface SignupContext {
  path?: string;
  /** The OAuth callback's `:id` route param; better-auth's path is the pattern. */
  provider?: string;
}

export function signupProvider(context: SignupContext | null | undefined): string {
  if (context?.provider) return context.provider.toLowerCase();
  return context?.path?.includes("/sign-up/email") ? "email" : "unknown";
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
  context: SignupContext | null,
): Promise<void> {
  // Every account can look at the demo workspace, however it was created.
  const demo = ensureDemoMembership(user.id);

  // Staff-provisioned users are not sign-ups; agents sign up in bulk, so they
  // get no welcome email or Slack post.
  if (!isSelfSignup(context) || signupProvider(context) === "agentid") {
    await demo;
    return;
  }

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
          provider: signupProvider(context),
          viaInvite: invite != null,
          facts,
          supportConsoleUrl: `${env.NEXT_PUBLIC_APP_URL}/admin`,
          totalUsers,
        });
      })
    : undefined;

  await Promise.all([demo, welcome, slack]);
}
