import { renderEmailCard } from "@traceroot/core";
import { sendSmtpEmail } from "./transport";
export { isSmtpConfigured } from "./transport";

/**
 * Sends the password reset link better-auth generated. `resetUrl` points at
 * better-auth's /reset-password/:token route, which checks the token and then
 * redirects to /auth/reset-password.
 */
export async function sendPasswordResetEmail({
  to,
  resetUrl,
}: {
  to: string;
  resetUrl: string;
}): Promise<void> {
  await sendSmtpEmail({
    to,
    subject: "Reset your traceroot password",
    html: renderEmailCard({
      title: "Reset your password",
      bodyHtml: `
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            We received a request to reset the password for your traceroot account. The link expires in 1 hour.
          </p>
        </td>
      </tr>`,
      buttonLabel: "Reset password",
      buttonUrl: resetUrl,
      footerText: "If you didn't ask to reset your password, you can ignore this email.",
    }),
    text: `Reset your traceroot password

We received a request to reset the password for your traceroot account. The link expires in 1 hour.

${resetUrl}

If you didn't ask to reset your password, you can ignore this email.`,
  });
}
