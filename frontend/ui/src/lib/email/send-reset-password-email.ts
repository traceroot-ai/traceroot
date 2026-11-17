/**
 * Email service for sending password reset links
 */
import nodemailer from "nodemailer";
import { escapeHtml, renderEmailCard } from "@traceroot/core";
import { resendConfig, sendEmail as sendResendEmail } from "@traceroot/core/email";
import { env } from "@/env";

export interface SendResetPasswordEmailParams {
  to: string;
  name?: string | null;
  resetUrl: string;
}

export function buildResetPasswordHtml(params: { name?: string | null; resetUrl: string }): string {
  const { name, resetUrl } = params;
  const greeting = name ? ` (${escapeHtml(name)})` : "";

  return renderEmailCard({
    title: "Reset your TraceRoot password",
    bodyHtml: `
      <!-- Body -->
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            We received a request to reset the password for your TraceRoot account${greeting}. Click the button below to choose a new password.
          </p>
        </td>
      </tr>`,
    buttonLabel: "Reset Password",
    buttonUrl: resetUrl,
    footerText:
      "If you did not request a password reset, you can safely ignore this email. The link will expire in 1 hour.",
  });
}

export function buildResetPasswordText(params: { resetUrl: string }): string {
  return `Reset your TraceRoot password\n\nWe received a request to reset your password. Use the following link to choose a new password:\n${params.resetUrl}\n\nIf you did not request a password reset, you can safely ignore this email. The link will expire in 1 hour.`;
}

/**
 * Send password reset email via Resend (transactional) or SMTP fallback.
 * If neither is configured, logs the reset link to console for local development.
 */
export async function sendResetPasswordEmail(params: SendResetPasswordEmailParams): Promise<void> {
  const { to, name, resetUrl } = params;
  const subject = "Reset your TraceRoot password";
  const html = buildResetPasswordHtml({ name, resetUrl });
  const text = buildResetPasswordText({ resetUrl });

  // 1. Try Resend if configured
  const resend = resendConfig();
  if (resend.apiKey && resend.from) {
    try {
      const res = await sendResendEmail({
        to,
        subject,
        html,
        text,
        kind: "transactional",
      });
      if (res.sent) {
        return;
      }
    } catch (err) {
      console.error("[Auth] Resend failed for password reset email:", err);
    }
  }

  // 2. Fall back to SMTP if configured
  const smtpUrl = env.TRACEROOT_SMTP_URL;
  const mailFrom = env.TRACEROOT_SMTP_MAIL_FROM;

  if (smtpUrl && mailFrom) {
    try {
      const url = new URL(smtpUrl);
      const transporter = nodemailer.createTransport({
        host: url.hostname,
        port: parseInt(url.port) || 587,
        secure: url.port === "465",
        auth: {
          user: decodeURIComponent(url.username),
          pass: decodeURIComponent(url.password),
        },
      });

      await transporter.sendMail({
        from: `TraceRoot <${mailFrom}>`,
        to,
        subject,
        html,
        text,
      });
      return;
    } catch (err) {
      console.error("[Auth] SMTP failed for password reset email:", err);
    }
  }

  // 3. Neither configured (e.g. local dev / self-hosted without mail)
  console.warn(`[Auth] Email service not configured. Password reset link for ${to}:\n${resetUrl}`);
}
