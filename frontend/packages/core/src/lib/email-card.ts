/**
 * Shared transactional-email card template.
 *
 * Single source of truth for the branded email layout used by the workspace
 * invite (frontend/ui), the usage-quota emails, and the detector digest
 * (frontend/worker): centered TraceRoot logo, title, caller-provided body
 * rows, one black CTA button, divider, and a muted footer note.
 *
 * Table-based markup with inline styles only, so it survives Gmail/Outlook
 * CSS stripping.
 */

const LOGO_URL =
  process.env.NEXT_PUBLIC_LOGO_URL ||
  "https://raw.githubusercontent.com/traceroot-ai/traceroot/main/frontend/ui/public/images/traceroot_icon.png";

/** Escape HTML special characters to prevent XSS. */
export function escapeHtml(str: string): string {
  return str.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * Render the branded email card as a complete standalone HTML document.
 *
 * Callers must pass pre-escaped HTML.
 *
 * @param params.title Card headline, rendered centered under the logo.
 * @param params.bodyHtml One or more complete `<tr>` sections placed between
 *   the title and the button.
 * @param params.buttonLabel CTA button text.
 * @param params.buttonUrl CTA button destination.
 * @param params.footerText Muted note under the divider explaining why the
 *   recipient got this email.
 */
export function renderEmailCard(params: {
  title: string;
  bodyHtml: string;
  buttonLabel: string;
  buttonUrl: string;
  footerText: string;
}): string {
  const { title, bodyHtml, buttonLabel, buttonUrl, footerText } = params;
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
          <img src="${LOGO_URL}" alt="TraceRoot" width="72" height="72" style="display: block; margin: 0 auto; border-radius: 14px;" />
        </td>
      </tr>

      <!-- Title -->
      <tr>
        <td style="padding: 0 40px 24px 40px; text-align: center;">
          <h1 style="font-size: 24px; font-weight: 600; margin: 0; color: #000; letter-spacing: -0.5px;">
            ${title}
          </h1>
        </td>
      </tr>
${bodyHtml}
      <!-- Button -->
      <tr>
        <td style="padding: 0 40px 40px 40px; text-align: center;">
          <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;">
            <tr>
              <td style="background-color: #000;">
                <a href="${buttonUrl}" style="display: inline-block; padding: 10px 20px; color: #ffffff; text-decoration: none; font-weight: 500; font-size: 14px;">
                  ${buttonLabel}
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
            ${footerText}
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}
