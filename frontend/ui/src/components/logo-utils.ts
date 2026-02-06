/**
 * TraceRoot logo SVG utilities - can be used on both server and client
 */

/**
 * TraceRoot logo SVG paths
 */
export const LOGO_SVG_CONTENT = `
  <circle cx="11.5" cy="3.5" r="2.5" />
  <circle cx="5.5" cy="11.5" r="2.5" />
  <circle cx="17.5" cy="11.5" r="2.5" />
  <line x1="11.5" y1="6" x2="11.5" y2="8" />
  <line x1="11.5" y1="8" x2="7.5" y2="10" />
  <line x1="11.5" y1="8" x2="15.5" y2="10" />
  <line x1="5.5" y1="14" x2="5.5" y2="17" />
  <line x1="17.5" y1="14" x2="17.5" y2="17" />
  <circle cx="5.5" cy="19.5" r="2.5" />
  <circle cx="17.5" cy="19.5" r="2.5" />
`.trim();

/**
 * Returns the full SVG element as a string for use in HTML emails
 * @param size - Width and height in pixels (default: 28)
 * @param strokeColor - Stroke color (default: "white")
 * @param strokeWidth - Stroke width (default: 1.5, use higher for email)
 */
export function getLogoSvgString(size = 28, strokeColor = "white", strokeWidth = 1.5): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 23 23" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${LOGO_SVG_CONTENT}</svg>`;
}
