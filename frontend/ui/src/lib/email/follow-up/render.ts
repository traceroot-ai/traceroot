import {
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
  EMAIL_LOGO_URL,
  EMAIL_PIXEL_WORDMARK_URL,
  escapeHtml,
} from "@traceroot/core";
import type { FollowUp } from "@/lib/lifecycle/follow-up";
import { greeting, LINK_STYLE } from "../welcome/copy";
import { FOLLOW_UP_SIGNOFF, followUpCopy, PRODUCT_OPT_OUT_LABEL, type FollowUpLinks } from "./copy";

const LINK = /\[([^\]]+)\]\(([^\s)]+)\)/g;
const COMMAND = /^ {4}/;

const toText = (paragraph: string) => paragraph.replace(LINK, "$1 ($2)");

function toHtml(paragraph: string): string {
  if (COMMAND.test(paragraph)) {
    return `<pre style="margin:0 0 16px;padding:10px 12px;background:#F4F4F6;border-radius:6px;font-size:13px;white-space:pre-wrap"><code>${escapeHtml(paragraph.replace(COMMAND, ""))}</code></pre>`;
  }
  return `<p>${escapeHtml(paragraph).replace(LINK, `<a href="$2" ${LINK_STYLE}>$1</a>`)}</p>`;
}

/** The black button of the product's email card, one per email at most. */
function buttonHtml(label: string, url: string): string {
  return [
    '<table cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px"><tr>',
    `<td bgcolor="${EMAIL_COLORS.ink}" style="background-color:${EMAIL_COLORS.ink};border-radius:6px">`,
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;color:#FFFFFF;text-decoration:none;font-weight:500;font-size:14px;border-radius:6px">${escapeHtml(label)}</a>`,
    "</td></tr></table>",
  ].join("");
}

export interface RenderFollowUpInput {
  campaign: FollowUp;
  firstName: string | null;
  links: FollowUpLinks;
  unsubscribeUrl: string;
}

/** One follow-up email, laid out as the welcome email: wordmark, greeting, body, sign-off, opt-out. */
export function renderFollowUp(input: RenderFollowUpInput): {
  subject: string;
  text: string;
  html: string;
} {
  const copy = followUpCopy(input.campaign, input.links);
  const after = copy.after ?? [];
  const text = [
    greeting(input.firstName),
    "",
    copy.paragraphs.map(toText).join("\n\n"),
    ...(copy.button ? ["", `${copy.button.label}: ${copy.button.url}`] : []),
    ...(after.length ? ["", after.map(toText).join("\n\n")] : []),
    "",
    ...FOLLOW_UP_SIGNOFF,
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
    `<p>${FOLLOW_UP_SIGNOFF.map(escapeHtml).join("<br>")}</p>`,
    `<p style="margin:20px 0 0"><img src="${EMAIL_LOGO_URL}" alt="traceroot" width="106" height="20" style="display:block;border:0;width:106px;height:20px"></p>`,
    `<p style="margin-top:32px;font-size:12px;color:${EMAIL_COLORS.muted}"><a href="${escapeHtml(input.unsubscribeUrl)}" ${LINK_STYLE}>${PRODUCT_OPT_OUT_LABEL}</a></p>`,
    "</div>",
    "</body></html>",
  ].join("\n");

  return { subject: copy.subject, text, html };
}
