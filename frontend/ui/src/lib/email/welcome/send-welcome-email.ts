// Sends the welcome once per user through sendOnce, which owns the claim, the
// config refusals (sender, topic) and the stamp. Never throws.
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
import { displayFirstName, renderWelcome } from "./render";

export async function sendWelcomeEmail(
  input: { userId: string; email: string; name: string | null },
  options: { db?: EmailSendClient; fetchImpl?: typeof fetch } = {},
): Promise<SendOnceResult> {
  const { userId, email } = input;
  return sendOnce(
    options.db ?? prisma,
    { userId, campaign: "welcome", kind: "product" },
    () => {
      const { replyTo } = resendConfig();
      const token = signUnsubscribeToken(email);
      const unsubscribeUrl = `${env.NEXT_PUBLIC_APP_URL}${UNSUBSCRIBE_PATH}?t=${token}`;
      const { subject, text, html } = renderWelcome({
        firstName: displayFirstName(input.name),
        appUrl: env.NEXT_PUBLIC_APP_URL,
        unsubscribeUrl,
      });
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
