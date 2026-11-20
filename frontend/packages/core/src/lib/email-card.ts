/**
 * Shared transactional-email card template.
 *
 * Single source of truth for the branded email layout used by the workspace
 * invite (frontend/ui), the usage-quota emails, and the detector digest
 * (frontend/worker): TraceRoot wordmark, left-aligned title, caller-provided
 * body rows, one ink CTA button, divider, and a muted footer note. Colors come
 * from the brandbook in Figma; see EMAIL_COLORS.
 *
 * Table-based markup with inline styles and a classic Outlook fallback, so it survives Gmail/Outlook
 * CSS stripping. The card lets long unbroken words wrap (detector names such
 * as "hallucination_detector", workspace names, emails), so a single token
 * can't widen it past a 320px screen; the setting inherits into body rows.
 *
 * Dark mode: the card asks to stay light (color-scheme "light only"), which Apple
 * Mail honors. Gmail and the Outlook apps darken it anyway. They recolor the
 * card and the button but never an image, so TraceRoot's logos carry their own
 * white plate (invisible on the white card; see EMAIL_STOCK_LOGOS) and the button has a border in its
 * own color, which those clients lighten into an outline on the dark card.
 */

const REPO_FILES = "https://raw.githubusercontent.com/traceroot-ai/traceroot";
const IMAGES_ON_MAIN = `${REPO_FILES}/main/frontend/ui/public/images`;

/** A logo for emails: where it is hosted and, when known, its size in pixels. */
export type EmailLogo = { url: string; pixels?: { width: number; height: number } };

/**
 * TraceRoot's own email logos, each on a white rounded plate so it stays visible
 * when a mail client darkens the email (mail clients drop SVG, and never recolor an
 * image). The URLs are pinned to the commits that added the files under
 * frontend/ui/public/images, so they load before those commits reach main and never
 * change under emails already sent. Drawn at 4x.
 */
export const EMAIL_STOCK_LOGOS = {
  wordmark: {
    url: `${REPO_FILES}/b5ba62b900f511ceece96980ad7adc5abf428674/frontend/ui/public/images/traceroot_wordmark_email.png`,
    pixels: { width: 572, height: 144 },
  },
  mark: {
    url: `${REPO_FILES}/cfdb6732708c9689e3a0e26cc81c0d9b9bf70915/frontend/ui/public/images/traceroot_icon_email.png`,
    pixels: { width: 144, height: 144 },
  },
} as const satisfies Record<string, EmailLogo>;

/**
 * Stock values of the logo setting, each drawn as its email logo: the released
 * Helm chart's square icon (branding.logoUrl) and .env.example's wordmark. Both
 * are dark artwork on a transparent background, which disappears on a darkened
 * email.
 */
const STOCK_LOGO_SETTINGS: Record<string, EmailLogo> = {
  [`${IMAGES_ON_MAIN}/traceroot_icon.png`]: EMAIL_STOCK_LOGOS.mark,
  [`${IMAGES_ON_MAIN}/traceroot_wordmark.png`]: EMAIL_STOCK_LOGOS.wordmark,
};

/**
 * The logo emails show for a NEXT_PUBLIC_LOGO_URL setting. Unset, it is the
 * wordmark; a stock value is drawn as TraceRoot's email version of the same logo;
 * anything else is the deployment's own branding and is used as given, at its own
 * proportions.
 */
export function emailLogo(setting = process.env.NEXT_PUBLIC_LOGO_URL): EmailLogo {
  const url = setting?.trim();
  if (!url) return EMAIL_STOCK_LOGOS.wordmark;
  return STOCK_LOGO_SETTINGS[url] ?? { url };
}

/**
 * The configured logo as an `<img>` `height` px tall. Clients that read CSS keep
 * the image's own proportions. Outlook sizes it from the attributes: both for a
 * logo whose size is known, so it is never stretched; only the height for custom
 * branding, whose shape is unknown here.
 */
export function emailLogoImg(height: number, logo: EmailLogo = emailLogo()): string {
  const size = logo.pixels
    ? `width="${Math.round((height * logo.pixels.width) / logo.pixels.height)}" height="${height}"`
    : `height="${height}"`;
  return `<img src="${escapeHtml(logo.url)}" alt="TraceRoot" ${size} style="display: block; border: 0; height: ${height}px; width: auto; max-width: 100%;" />`;
}

/** Email-safe PNG of the green website footer wordmark, rendered at 2×. */
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
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
    <!--[if mso]>
    <style>h1, p, td, a { word-break: break-all; }</style>
    <![endif]-->
  </head>
  <body style="font-family: ${EMAIL_FONT_STACK}; line-height: 1.6; color: ${c.ink}; margin: 0; padding: 32px 16px; background-color: ${c.surface};">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 560px; margin: 0 auto; background: ${c.white}; border: 1px solid ${c.border}; border-top: 3px solid ${c.accent}; border-radius: 8px; border-collapse: separate; word-break: break-word; overflow-wrap: anywhere;">
      <!-- Logo section -->
      <tr>
        <td style="padding: 26px 32px 0 32px;">
          ${emailLogoImg(36)}
        </td>
      </tr>

      <!-- Title -->
      <tr>
        <td style="padding: 26px 40px 16px 40px;">
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
              <td bgcolor="${c.ink}" style="background-color: ${c.ink}; border: 1px solid ${c.ink}; border-radius: 6px;">
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
