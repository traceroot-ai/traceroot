import nodemailer from "nodemailer";
import { renderEmailCard } from "@traceroot/core";
import { env } from "@/env";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isSmtpConfigured(): boolean {
  return Boolean(env.TRACEROOT_SMTP_URL?.trim() && env.TRACEROOT_SMTP_MAIL_FROM?.trim());
}

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
  const smtpUrl = env.TRACEROOT_SMTP_URL;
  const mailFrom = env.TRACEROOT_SMTP_MAIL_FROM;
  if (!smtpUrl || !mailFrom) {
    console.warn(
      "[Email] SMTP not configured. Set TRACEROOT_SMTP_URL and TRACEROOT_SMTP_MAIL_FROM to enable password reset emails.",
    );
    return;
  }

  const url = new URL(smtpUrl);
  const secure = url.protocol === "smtps:" || url.port === "465";
  const transporter = nodemailer.createTransport({
    host: url.hostname,
    port: parseInt(url.port) || (secure ? 465 : 587),
    secure,
    // The email carries a working reset link, so never send it in plaintext: without
    // implicit TLS, STARTTLS is mandatory. A loopback relay never leaves the host.
    requireTLS: !secure && !LOOPBACK_HOSTS.has(url.hostname),
    auth: {
      user: decodeURIComponent(url.username),
      pass: decodeURIComponent(url.password),
    },
  });

  await transporter.sendMail({
    from: `TraceRoot <${mailFrom}>`,
    to,
    subject: "Reset your TraceRoot password",
    html: renderEmailCard({
      title: "Reset your password",
      bodyHtml: `
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            We received a request to reset the password for your TraceRoot account. The link expires in 1 hour.
          </p>
        </td>
      </tr>`,
      buttonLabel: "Reset password",
      buttonUrl: resetUrl,
      footerText: "If you didn't ask to reset your password, you can ignore this email.",
    }),
    text: `Reset your TraceRoot password

We received a request to reset the password for your TraceRoot account. The link expires in 1 hour.

${resetUrl}

If you didn't ask to reset your password, you can ignore this email.`,
  });
}
