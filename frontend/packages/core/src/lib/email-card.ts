/**
 * Shared transactional-email card template.
 *
 * Single source of truth for the branded email layout used by the workspace
 * invite (frontend/ui), the usage-quota emails, and the detector digest
 * (frontend/worker): TraceRoot wordmark, left-aligned title, caller-provided
 * body rows, one ink CTA button, divider, and a muted footer note. Colors come
 * from the brandbook in Figma; see EMAIL_COLORS.
 *
 * Table-based markup with inline styles only, so it survives Gmail/Outlook
 * CSS stripping.
 */

/**
 * Hosted PNG of the wordmark (mark + "traceroot"); mail clients drop SVG.
 * NEXT_PUBLIC_LOGO_URL overrides it and is rendered at 127x24, so an override
 * must be wordmark-shaped (about 5.3:1), not the square icon.
 */
export const EMAIL_LOGO_URL =
  process.env.NEXT_PUBLIC_LOGO_URL ||
  "https://raw.githubusercontent.com/traceroot-ai/traceroot/main/frontend/ui/public/images/traceroot_wordmark.png";

/**
 * Hosted PNG of the website footer's pixel wordmark: a still frame of the
 * dithered "traceroot" with the turquoise sweep frozen in place, as on
 * traceroot.ai. Static on purpose: an animated GIF loads more slowly in the
 * header. Rendered from docs/brand/footer-wordmark.svg at 960x154 (2x).
 */
export const EMAIL_PIXEL_WORDMARK_URL =
  "https://raw.githubusercontent.com/traceroot-ai/traceroot/main/frontend/ui/public/images/traceroot_pixel_wordmark.png";

/**
 * Brand palette from the Figma brandbook ("09_Color System"), plus one muted
 * text tone derived from the ink so secondary copy stays readable (the two
 * brand grays are surface colors and are too light for text).
 */
export const EMAIL_COLORS = {
  ink: "#0B1015",
  muted: "#5F646B",
  border: "#DFDFDF",
  surface: "#F4F4F6",
  white: "#FFFFFF",
  accent: "#14B8B0",
} as const;

/** Geist is the brand face; most mail clients fall back to the system stack. */
export const EMAIL_FONT_STACK =
  "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

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
 * @param params.title Card headline, rendered under the wordmark.
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
  const c = EMAIL_COLORS;
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="font-family: ${EMAIL_FONT_STACK}; line-height: 1.6; color: ${c.ink}; margin: 0; padding: 32px 16px; background-color: ${c.surface};">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 560px; margin: 0 auto; background: ${c.white}; border: 1px solid ${c.border}; border-top: 3px solid ${c.accent}; border-radius: 8px; border-collapse: separate;">
      <!-- Logo section -->
      <tr>
        <td style="padding: 32px 40px 0 40px;">
          <img src="${EMAIL_LOGO_URL}" alt="TraceRoot" width="127" height="24" style="display: block; border: 0; height: 24px; width: 127px;" />
        </td>
      </tr>

      <!-- Title -->
      <tr>
        <td style="padding: 32px 40px 16px 40px;">
          <h1 style="font-size: 22px; line-height: 1.3; font-weight: 600; margin: 0; color: ${c.ink}; letter-spacing: -0.4px;">
            ${title}
          </h1>
        </td>
      </tr>
${bodyHtml}
      <!-- Button -->
      <tr>
        <td style="padding: 0 40px 36px 40px;">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="background-color: ${c.ink}; border-radius: 6px;">
                <a href="${buttonUrl}" style="display: inline-block; padding: 11px 20px; color: ${c.white}; text-decoration: none; font-weight: 500; font-size: 14px; border-radius: 6px;">
                  ${buttonLabel}
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Divider -->
      <tr>
        <td style="border-top: 1px solid ${c.border};"></td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding: 20px 40px 24px 40px;">
          <p style="color: ${c.muted}; font-size: 12px; line-height: 1.6; margin: 0;">
            ${footerText}
          </p>
          <p style="color: ${c.muted}; font-size: 12px; line-height: 1.6; margin: 8px 0 0 0;">
            TraceRoot &middot; <a href="https://traceroot.ai" style="color: ${c.muted}; text-decoration: underline;">traceroot.ai</a>
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}
