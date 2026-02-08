/**
 * Email service for sending workspace invitations
 */
import nodemailer from 'nodemailer';

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

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
 * - NEXTAUTH_URL: Base URL for the app
 */
export async function sendInviteEmail(params: SendInviteEmailParams): Promise<void> {
  const { to, inviterName, inviterEmail, workspaceName, inviteId, role } = params;

  const smtpUrl = process.env.TRACEROOT_SMTP_URL;
  const mailFrom = process.env.TRACEROOT_SMTP_MAIL_FROM;
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

  if (!smtpUrl || !mailFrom) {
    console.warn('[Email] SMTP not configured. Set TRACEROOT_SMTP_URL and TRACEROOT_SMTP_MAIL_FROM to enable invite emails.');
    return;
  }

  // Parse SMTP URL: smtp://user:pass@host:port
  const url = new URL(smtpUrl);
  const transporter = nodemailer.createTransport({
    host: url.hostname,
    port: parseInt(url.port) || 587,
    secure: url.port === '465', // true for 465, false for other ports (uses STARTTLS)
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

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #fafafa;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5;">
      <!-- Logo section -->
      <tr>
        <td style="padding: 40px 40px 32px 40px; text-align: center;">
          <img src="${process.env.NEXT_PUBLIC_LOGO_URL || 'https://raw.githubusercontent.com/traceroot-ai/traceroot/pivot/agentops/frontend/ui/public/images/icon-v2.png'}" alt="TraceRoot" width="72" height="72" style="display: block; margin: 0 auto; border-radius: 14px;" />
        </td>
      </tr>

      <!-- Title -->
      <tr>
        <td style="padding: 0 40px 24px 40px; text-align: center;">
          <h1 style="font-size: 24px; font-weight: 600; margin: 0; color: #000; letter-spacing: -0.5px;">
            Join ${safeWorkspaceName} on TraceRoot
          </h1>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            <strong>${safeInviterName}</strong> (${safeInviterEmail}) has invited you to join the <strong>${safeWorkspaceName}</strong> workspace as a <strong>${safeRoleName}</strong>.
          </p>
        </td>
      </tr>

      <!-- Button -->
      <tr>
        <td style="padding: 0 40px 40px 40px; text-align: center;">
          <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;">
            <tr>
              <td style="background-color: #000;">
                <a href="${acceptLink}" style="display: inline-block; padding: 10px 20px; color: #ffffff; text-decoration: none; font-weight: 500; font-size: 14px;">
                  Accept Invitation
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Divider -->
      <tr>
        <td style="border-top: 1px solid #e5e5e5;"></td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding: 24px 40px; background-color: #fafafa;">
          <p style="color: #999; font-size: 12px; margin: 0; text-align: center;">
            If you were not expecting this invitation, you can ignore this email.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
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
