/**
 * Email service for sending workspace invitations
 */
import nodemailer from "nodemailer";
import { escapeHtml, renderEmailCard } from "@traceroot/core";
import { env } from "@/env";

interface SendInviteEmailParams {
  to: string;
  inviterName: string;
  inviterEmail: string;
  workspaceName: string;
  inviteId: string;
  role: string;
}

/**
 * Send workspace invitation email
 *
 * Required env vars:
 * - TRACEROOT_SMTP_URL: SMTP connection string (e.g., smtp://user:pass@host:port)
 * - TRACEROOT_SMTP_MAIL_FROM: Sender email address
 * - BETTER_AUTH_URL: Base URL for the app
 */
export async function sendInviteEmail(params: SendInviteEmailParams): Promise<void> {
  const { to, inviterName, inviterEmail, workspaceName, inviteId, role } = params;

  const smtpUrl = env.TRACEROOT_SMTP_URL;
  const mailFrom = env.TRACEROOT_SMTP_MAIL_FROM;
  const baseUrl = env.BETTER_AUTH_URL;

  if (!smtpUrl || !mailFrom) {
    console.warn(
      "[Email] SMTP not configured. Set TRACEROOT_SMTP_URL and TRACEROOT_SMTP_MAIL_FROM to enable invite emails.",
    );
    return;
  }

  // Parse SMTP URL: smtp://user:pass@host:port
  const url = new URL(smtpUrl);
  const transporter = nodemailer.createTransport({
    host: url.hostname,
    port: parseInt(url.port) || 587,
    secure: url.port === "465", // true for 465, false for other ports (uses STARTTLS)
    auth: {
      user: decodeURIComponent(url.username),
      pass: decodeURIComponent(url.password),
    },
  });
  const acceptLink = `${baseUrl}/invites/${inviteId}`;
  const roleName = role.charAt(0) + role.slice(1).toLowerCase();

  await transporter.sendMail({
    from: `TraceRoot <${mailFrom}>`,
    to,
    subject: `${inviterName} invited you to join "${workspaceName}" on TraceRoot`,
    html: buildHtmlEmail({ inviterName, inviterEmail, workspaceName, acceptLink, roleName }),
    text: buildTextEmail({ inviterName, inviterEmail, workspaceName, acceptLink, roleName }),
  });

  console.log(`[Email] Invite email sent to ${to}`);
}

interface EmailContentParams {
  inviterName: string;
  inviterEmail: string;
  workspaceName: string;
  acceptLink: string;
  roleName: string;
}

function buildHtmlEmail(params: EmailContentParams): string {
  const { inviterName, inviterEmail, workspaceName, acceptLink, roleName } = params;

  // Escape user-provided data to prevent XSS
  const safeInviterName = escapeHtml(inviterName);
  const safeInviterEmail = escapeHtml(inviterEmail);
  const safeWorkspaceName = escapeHtml(workspaceName);
  const safeRoleName = escapeHtml(roleName);

  return renderEmailCard({
    title: `Join ${safeWorkspaceName} on TraceRoot`,
    bodyHtml: `
      <!-- Body -->
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            <strong>${safeInviterName}</strong> (${safeInviterEmail}) has invited you to join the <strong>${safeWorkspaceName}</strong> workspace as a <strong>${safeRoleName}</strong>.
          </p>
        </td>
      </tr>`,
    buttonLabel: "Accept Invitation",
    buttonUrl: acceptLink,
    footerText: "If you were not expecting this invitation, you can ignore this email.",
  });
}

function buildTextEmail(params: EmailContentParams): string {
  const { inviterName, inviterEmail, workspaceName, acceptLink, roleName } = params;

  return `
You've been invited to TraceRoot

${inviterName} (${inviterEmail}) has invited you to join the "${workspaceName}" workspace as a ${roleName}.

Accept the invitation:
${acceptLink}

If you don't have a TraceRoot account, you'll be prompted to create one.

---
If you didn't expect this invitation, you can safely ignore this email.
  `.trim();
}
