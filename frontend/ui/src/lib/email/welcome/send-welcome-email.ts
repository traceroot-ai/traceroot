// Sends the welcome once per user through sendOnce, which owns the claim, the
// config refusals (sender, reply-to, topic) and the stamp. Never throws.
import { prisma } from "@traceroot/core";
import {
  resendConfig,
  sendOnce,
  signUnsubscribeToken,
  unsubscribeHeaders,
  UNSUBSCRIBE_PATH,
  type EmailSendClient,
  type SendOnceResult,
} from "@traceroot/core/email";
import { env } from "@/env";
import { clientEnv } from "@/env.client";
import { isCloud } from "@/lib/server/cloud";
import { followUpMode } from "@/lib/lifecycle/follow-up-job";
import { demoProjectUrl } from "../demo-link";
import { renderFounderEmail } from "../founder-email";
import { founderWelcomeCopy, type WelcomeVariant } from "./founder-copy";
import { slackInviteLineFor } from "./slack-invite-line";
import { displayFirstName, renderWelcome } from "./render";

export async function sendWelcomeEmail(
  input: {
    userId: string;
    email: string;
    name: string | null;
    /** The cloud version; the self-hosted welcome has one. */
    variant?: WelcomeVariant;
  },
  options: { db?: EmailSendClient; fetchImpl?: typeof fetch } = {},
): Promise<SendOnceResult> {
  const { userId, email } = input;
  // The cloud service's welcome is the founder's; a self-hosted install keeps
  // the original one, signed by the team.
  const cloud = isCloud();
  // A link to the app instead of the demo project is better than no welcome.
  const demoUrl = cloud
    ? await demoProjectUrl(env.NEXT_PUBLIC_APP_URL).catch(() => env.NEXT_PUBLIC_APP_URL)
    : "";
  return sendOnce(
    options.db ?? prisma,
    { userId, campaign: "welcome", kind: "product" },
    () => {
      const { replyTo } = resendConfig();
      const token = signUnsubscribeToken(email);
      const unsubscribeUrl = `${env.NEXT_PUBLIC_APP_URL}${UNSUBSCRIBE_PATH}?t=${token}`;
      const firstName = displayFirstName(input.name);
      const { subject, text, html } = cloud
        ? renderFounderEmail(
            founderWelcomeCopy({
              variant: input.variant ?? "generic",
              appUrl: env.NEXT_PUBLIC_APP_URL,
              demoUrl,
              bookingUrl: clientEnv.NEXT_PUBLIC_FOUNDERS_CAL_URL,
              githubUrl: clientEnv.NEXT_PUBLIC_GITHUB_REPO_URL,
              // Promised only while the follow-ups are actually being sent.
              followUpLine: followUpMode() === "send",
              slackInviteLine: slackInviteLineFor(email),
            }),
            { firstName, unsubscribeUrl },
          )
        : renderWelcome({ firstName, appUrl: env.NEXT_PUBLIC_APP_URL, unsubscribeUrl });
      return {
        to: email,
        subject,
        text,
        html,
        kind: "product",
        replyTo,
        idempotencyKey: `welcome/${userId}`,
        tags: { category: "product", template: "welcome" },
        headers: unsubscribeHeaders({ url: unsubscribeUrl, mailto: replyTo ?? "" }),
      };
    },
    { fetchImpl: options.fetchImpl },
  );
}
