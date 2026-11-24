import {
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
  EMAIL_PIXEL_WORDMARK_URL,
  escapeHtml,
} from "@traceroot/core";
import { PRODUCT_FOOTER_SLOT } from "@traceroot/core/email";
import type { FollowUp } from "@/lib/lifecycle/follow-up";
import { greeting, LINK_STYLE } from "../welcome/copy";
import { FOLLOW_UP_SIGNOFF, followUpCopy, PRODUCT_OPT_OUT_LABEL, type FollowUpLinks } from "./copy";

const LINK = /\[([^\]]+)\]\(([^\s)]+)\)/g;
const COMMAND = /^ {4}/;

const toText = (paragraph: string) => paragraph.replace(LINK, "$1 ($2)");

// The approved layout, in pixels. Every gap is the top margin of the block
// below it, so none depends on a mail client's default paragraph spacing.
const LAYOUT = {
  column: 500,
  side: 24,
  top: 32,
  bottom: 28,
  wordmarkWidth: 160,
  afterWordmark: 32,
  afterGreeting: 12,
  betweenParagraphs: 16,
  beforeButton: 20,
  buttonHeight: 44,
  afterButton: 16,
  beforeSignoff: 32,
  beforeUnsubscribe: 40,
  beforeAddress: 4,
} as const;
const TEXT = "font-size:16px;line-height:25px";
const SIGNOFF = "font-size:15px;line-height:22px";
const FOOTER = `font-size:12px;line-height:18px;color:${EMAIL_COLORS.muted}`;

function toHtml(paragraph: string, marginTop: number): string {
  if (COMMAND.test(paragraph)) {
    return `<pre style="margin:${marginTop}px 0 0;padding:10px 12px;background:#F4F4F6;border-radius:6px;font-size:13px;line-height:20px;white-space:pre-wrap"><code>${escapeHtml(paragraph.replace(COMMAND, ""))}</code></pre>`;
  }
  return `<p style="margin:${marginTop}px 0 0;${TEXT}">${escapeHtml(paragraph).replace(LINK, `<a href="$2" ${LINK_STYLE}>$1</a>`)}</p>`;
}

/** The black button of the product's email card, one per email at most, left-aligned. */
function buttonHtml(label: string, url: string): string {
  const h = LAYOUT.buttonHeight;
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="left" style="margin:${LAYOUT.beforeButton}px 0 0;border-collapse:separate"><tr>`,
    `<td height="${h}" bgcolor="${EMAIL_COLORS.ink}" style="height:${h}px;background-color:${EMAIL_COLORS.ink};border-radius:6px">`,
    `<a href="${escapeHtml(url)}" style="display:inline-block;height:${h}px;line-height:${h}px;padding:0 20px;color:#FFFFFF;text-decoration:none;font-weight:500;font-size:15px;border-radius:6px">${escapeHtml(label)}</a>`,
    "</td></tr></table>",
    // Ends the left float some clients give an aligned table.
    '<div style="clear:both;font-size:0;line-height:0">&nbsp;</div>',
  ].join("");
}

export interface RenderFollowUpInput {
  campaign: FollowUp;
  firstName: string | null;
  links: FollowUpLinks;
  unsubscribeUrl: string;
}

/** One follow-up email in the approved layout: wordmark, greeting, body, button, sign-off, opt-out, address. */
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

  const body = [
    ...copy.paragraphs.map((p, i) => toHtml(p, i === 0 ? 0 : LAYOUT.betweenParagraphs)),
    ...(copy.button ? [buttonHtml(copy.button.label, copy.button.url)] : []),
    ...after.map((p, i) =>
      toHtml(p, copy.button && i === 0 ? LAYOUT.afterButton : LAYOUT.betweenParagraphs),
    ),
  ];
  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="margin:0;padding:0;background-color:#FFFFFF">`,
    `<div style="max-width:${LAYOUT.column}px;margin:0 auto;padding:${LAYOUT.top}px ${LAYOUT.side}px ${LAYOUT.bottom}px;font-family:${EMAIL_FONT_STACK};${TEXT};color:${EMAIL_COLORS.ink}">`,
    `<img src="${EMAIL_PIXEL_WORDMARK_URL}" alt="traceroot" width="${LAYOUT.wordmarkWidth}" style="display:block;border:0;width:${LAYOUT.wordmarkWidth}px;height:auto;margin:0 0 ${LAYOUT.afterWordmark}px">`,
    `<p style="margin:0 0 ${LAYOUT.afterGreeting}px;${TEXT}">${escapeHtml(greeting(input.firstName))}</p>`,
    ...body,
    `<p style="margin:${LAYOUT.beforeSignoff}px 0 0;${SIGNOFF}">${FOLLOW_UP_SIGNOFF.map(escapeHtml).join("<br>")}</p>`,
    `<p style="margin:${LAYOUT.beforeUnsubscribe}px 0 0;${FOOTER}"><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${EMAIL_COLORS.muted};text-decoration:underline">${PRODUCT_OPT_OUT_LABEL}</a></p>`,
    // The provider adds the postal address here (PRODUCT_FOOTER_SLOT), so it
    // sits in the same column and style as the unsubscribe line.
    `<p style="margin:${LAYOUT.beforeAddress}px 0 0;${FOOTER}">${PRODUCT_FOOTER_SLOT}</p>`,
    "</div>",
    "</body></html>",
  ].join("\n");

  return { subject: copy.subject, text, html };
}
