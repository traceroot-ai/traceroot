// Everything that follows a new account (demo workspace access, Resend contact,
// welcome email, Slack notice, sign-up webhook), run from better-auth's
// user.create.after hook. Each arm is on only when its own config is set and
// never rejects. The contact is created before the welcome because Resend
// delivers topic mail to non-contacts, and the opt-out needs a record.
import { prisma } from "@traceroot/core";
import { ensureContact, isProductMailConfigured } from "@traceroot/core/email";
import {
  buildSignupWebhookEvent,
  isSignupWebhookConfigured,
  sendSignupWebhook,
} from "@traceroot/core/signup-webhook";
import { env } from "@/env";
import { sendWelcomeEmail } from "@/lib/email/welcome/send-welcome-email";
import { ensureDemoMembership } from "@/lib/demo-workspace";
import { findPostHogPerson } from "./posthog-person";
import { notifySignupSlack } from "./notify-slack";
import { isSelfSignup, signupProvider, type SignupRequest } from "./attribution";

export interface CreatedUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
}

// What the follow-ups read about the sign-up request: better-auth's matched
// route and its params, and the campaign attribution the request carried.
export interface SignupContext extends SignupRequest {
  attribution?: Record<string, string>;
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

  // A user provisioned by staff through the admin plugin is not a sign-up.
  if (!isSelfSignup(context)) {
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

  const slackOn = Boolean(env.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL?.trim());
  const webhookConfig = {
    url: env.TRACEROOT_SIGNUP_WEBHOOK_URL,
    secret: env.TRACEROOT_SIGNUP_WEBHOOK_SECRET,
  };
  const webhookOn = isSignupWebhookConfigured(webhookConfig);

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

  // Once the receiver acknowledges the event, the weekly replay leaves this
  // user out; until then (a failed send, or a failed write here) it sends the
  // sign-up again, and the receiver drops the repeat.
  const webhook = webhookOn
    ? arm("signup webhook", user.id, async () => {
        const delivered = await sendSignupWebhook(
          buildSignupWebhookEvent({
            user,
            provider: signupProvider(context),
            viaInvite: await invited,
            attribution: context?.attribution,
          }),
          webhookConfig,
        );
        if (delivered) {
          await prisma.user.updateMany({
            where: { id: user.id, signupDeliveredAt: null },
            data: { signupDeliveredAt: new Date() },
          });
        }
      })
    : undefined;

  await Promise.all([demo, welcome, slack, webhook]);
}
