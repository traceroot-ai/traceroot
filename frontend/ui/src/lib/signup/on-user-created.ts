// Everything that follows a new account (Resend contact,
// welcome email or its cloud due time, Slack notice, and sign-up webhook)
// runs from better-auth's user.create.after hook. Each arm is on only when
// its own config is set and never rejects. The contact is created before the
// welcome because Resend delivers topic mail to non-contacts and the opt-out
// needs a record.
import { prisma } from "@traceroot/core";
import { ensureContact, isProductMailConfigured } from "@traceroot/core/email";
import { env } from "@/env";
import { sendWelcomeEmail } from "@/lib/email/welcome/send-welcome-email";
import { scheduleWelcome } from "@/lib/email/welcome/welcome-schedule";
import { isCloud } from "@/lib/server/cloud";
import { AGENTID_PROVIDER_ID } from "@/lib/social-providers";
import { findPostHogPerson } from "./posthog-person";
import { notifySignupSlack } from "./notify-slack";
import { buildSignupWebhookEvent, sendSignupWebhook } from "./signup-webhook";
import { isSelfSignup } from "./attribution";

export interface CreatedUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
}

// What the follow-ups read about the sign-up request: better-auth's matched
// route, the provider from the OAuth callback's `:id` route param, and the
// campaign attribution the request carried.
export interface SignupContext {
  path?: string;
  /** The OAuth callback's `:id` route param; better-auth's path is the pattern. */
  provider?: string;
  attribution?: Record<string, string>;
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
  // Staff-provisioned users are not sign-ups; agents sign up in bulk, so they
  // get no welcome email or Slack post.
  if (!isSelfSignup(context) || signupProvider(context) === AGENTID_PROVIDER_ID) {
    return;
  }

  // The contact is made at sign-up wherever the welcome is sent: the newsletter
  // and the opt-out need everyone who signed up to be one.
  const welcome = isProductMailConfigured()
    ? arm("welcome email", user.id, async () => {
        const contact = await arm("resend contact", user.id, () =>
          ensureContact({ email: user.email, name: user.name }),
        );
        // The cloud welcome waits for the sign-up questions, 15 minutes at
        // most (lib/email/welcome/welcome-schedule.ts).
        if (isCloud()) return scheduleWelcome(user.id);
        if (!contact?.ok) {
          console.warn(`[signup] welcome email skipped for user ${user.id}: contact not recorded`);
          return;
        }
        return sendWelcomeEmail({ userId: user.id, email: user.email, name: user.name });
      })
    : undefined;

  const slackOn = Boolean(env.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL?.trim());
  const webhookOn = Boolean(
    env.TRACEROOT_SIGNUP_WEBHOOK_URL?.trim() && env.TRACEROOT_SIGNUP_WEBHOOK_SECRET?.trim(),
  );

  // The Slack post and the webhook both say whether the user was invited.
  const invited =
    slackOn || webhookOn
      ? arm("invite lookup", user.id, () =>
          prisma.invite.findFirst({
            where: { email: { equals: user.email, mode: "insensitive" } },
            select: { id: true },
          }),
        ).then((invite) => invite != null)
      : Promise.resolve(false);

  const slack = slackOn
    ? arm("slack", user.id, async () => {
        const [viaInvite, facts, totalUsers] = await Promise.all([
          invited,
          findPostHogPerson(user.id),
          arm("user count", user.id, () => prisma.user.count()),
        ]);
        return notifySignupSlack({
          name: user.name,
          email: user.email,
          provider: signupProvider(context),
          viaInvite,
          facts,
          supportConsoleUrl: `${env.NEXT_PUBLIC_APP_URL}/admin`,
          totalUsers,
        });
      })
    : undefined;

  const webhook = webhookOn
    ? arm("signup webhook", user.id, async () =>
        sendSignupWebhook(
          buildSignupWebhookEvent({
            user,
            provider: signupProvider(context),
            viaInvite: await invited,
            attribution: context?.attribution,
          }),
        ),
      )
    : undefined;

  await Promise.all([welcome, slack, webhook]);
}
