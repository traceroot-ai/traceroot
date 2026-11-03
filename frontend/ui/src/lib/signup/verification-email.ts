// The email-verification link better-auth asks for at sign-up (and again on a
// sign-in attempt by an unverified account). Sent as transactional mail through
// the shared Resend client, so it needs only the API key and sender: no topic,
// no reply-to and no unsubscribe, unlike product mail.
import { renderEmailCard } from "@traceroot/core";
import { resendConfig, sendEmail, type ResendOptions } from "@traceroot/core/email";

/**
 * Verification is only required when the link can actually be delivered. A
 * deployment without mail (most self-hosted installs) keeps instant access
 * rather than locking every new account out.
 */
export function isVerificationMailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const { apiKey, from } = resendConfig(env);
  return Boolean(apiKey && from);
}

export const VERIFICATION_SUBJECT = "Verify your email for TraceRoot";

export function renderVerificationEmail(url: string): { text: string; html: string } {
  const text = [
    "Confirm your email address to finish creating your TraceRoot account:",
    url,
    "The link expires in 24 hours. If you didn't sign up, you can ignore this email.",
  ].join("\n\n");
  const html = renderEmailCard({
    title: "Verify your email",
    bodyHtml: `
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            Confirm your email address to finish creating your TraceRoot account.
          </p>
        </td>
      </tr>`,
    buttonLabel: "Verify email",
    buttonUrl: url,
    footerText: "The link expires in 24 hours. If you didn't sign up, you can ignore this email.",
  });
  return { text, html };
}

/**
 * Never throws: better-auth awaits this inside the sign-up and sign-in
 * requests, and a provider hiccup must not turn into a 500 after the account
 * row exists. The user can get a fresh link by signing in again.
 */
export async function sendVerificationEmail(
  { user, url }: { user: { id: string; email: string }; url: string },
  options: ResendOptions = {},
): Promise<void> {
  try {
    const result = await sendEmail(
      {
        to: user.email,
        subject: VERIFICATION_SUBJECT,
        ...renderVerificationEmail(url),
        kind: "transactional",
        tags: { category: "transactional", template: "verify-email" },
      },
      options,
    );
    if (!result.sent) console.warn(`[signup] verification email skipped (${result.reason})`);
  } catch (error) {
    console.error(`[signup] verification email failed for user ${user.id}:`, error);
  }
}
