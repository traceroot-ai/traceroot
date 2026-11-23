/**
 * The founder-signed product emails on the cloud service: the welcome email
 * and the follow-ups (and the monthly newsletter, when it gets a template). One
 * layout and one sign-off, so they cannot drift apart.
 *
 * Laid out as the welcome email: the pixel wordmark, "Hi <name>,", the body,
 * the sign-off, the small wordmark, and the opt-out line linking to the
 * unsubscribe page. In a paragraph, `[label](url)` is a link and a line
 * indented four spaces is a command.
 */
import {
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
  EMAIL_LOGO_URL,
  EMAIL_PIXEL_WORDMARK_URL,
  escapeHtml,
} from "@traceroot/core";
import { greeting, LINK_STYLE } from "./welcome/copy";

/** "Best," and Xinwei's signature, written as in his own email. */
export const FOUNDER_SIGNOFF = ["Best,", "Xinwei He", "TraceRoot.AI | CEO"];

/** The opt-out under the signature, linked to the unsubscribe page. */
export const PRODUCT_OPT_OUT_LABEL = "Unsubscribe from product emails";

export interface FounderEmailCopy {
  subject: string;
  paragraphs: string[];
  /** At most one; drawn as a black button, written out in the plain-text part. */
  button?: { label: string; url: string };
  /** Paragraphs after the button. */
  after?: string[];
}

const LINK = /\[([^\]]+)\]\(([^\s)]+)\)/g;
const COMMAND = /^ {4}/;

const toText = (paragraph: string) => paragraph.replace(LINK, "$1 ($2)");

function toHtml(paragraph: string): string {
  if (COMMAND.test(paragraph)) {
    return `<pre style="margin:0 0 16px;padding:10px 12px;background:#F4F4F6;border-radius:6px;font-size:13px;white-space:pre-wrap"><code>${escapeHtml(paragraph.replace(COMMAND, ""))}</code></pre>`;
  }
  return `<p>${escapeHtml(paragraph).replace(LINK, `<a href="$2" ${LINK_STYLE}>$1</a>`)}</p>`;
}

/** The black button of the product's email card. */
function buttonHtml(label: string, url: string): string {
  return [
    '<table cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px"><tr>',
    `<td bgcolor="${EMAIL_COLORS.ink}" style="background-color:${EMAIL_COLORS.ink};border-radius:6px">`,
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;color:#FFFFFF;text-decoration:none;font-weight:500;font-size:14px;border-radius:6px">${escapeHtml(label)}</a>`,
    "</td></tr></table>",
  ].join("");
}

export function renderFounderEmail(
  copy: FounderEmailCopy,
  input: { firstName: string | null; unsubscribeUrl: string },
): { subject: string; text: string; html: string } {
  const after = copy.after ?? [];
  const text = [
    greeting(input.firstName),
    "",
    copy.paragraphs.map(toText).join("\n\n"),
    ...(copy.button ? ["", `${copy.button.label}: ${copy.button.url}`] : []),
    ...(after.length ? ["", after.map(toText).join("\n\n")] : []),
    "",
    ...FOUNDER_SIGNOFF,
    "",
    `${PRODUCT_OPT_OUT_LABEL}: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"></head>',
    `<body style="margin:0;padding:24px 16px;font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:1.6;color:${EMAIL_COLORS.ink}">`,
    '<div style="max-width:560px;margin:0 auto">',
    `<p style="margin:0 0 28px"><img src="${EMAIL_PIXEL_WORDMARK_URL}" alt="" width="480" height="77" style="display:block;border:0;width:100%;max-width:480px;height:auto"></p>`,
    `<p>${escapeHtml(greeting(input.firstName))}</p>`,
    ...copy.paragraphs.map(toHtml),
    ...(copy.button ? [buttonHtml(copy.button.label, copy.button.url)] : []),
    ...after.map(toHtml),
    `<p>${FOUNDER_SIGNOFF.map(escapeHtml).join("<br>")}</p>`,
    `<p style="margin:20px 0 0"><img src="${EMAIL_LOGO_URL}" alt="traceroot" width="106" height="20" style="display:block;border:0;width:106px;height:20px"></p>`,
    `<p style="margin-top:32px;font-size:12px;color:${EMAIL_COLORS.muted}"><a href="${escapeHtml(input.unsubscribeUrl)}" ${LINK_STYLE}>${PRODUCT_OPT_OUT_LABEL}</a></p>`,
    "</div>",
    "</body></html>",
  ].join("\n");

  return { subject: copy.subject, text, html };
}
