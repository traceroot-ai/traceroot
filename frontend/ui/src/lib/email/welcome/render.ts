// Renders the welcome as text and HTML. Deliberately not the card template: the
// welcome reads as a short note, so the HTML is a few paragraphs, one list and links,
// headed by the website footer's pixel wordmark and signed with the wordmark
// under the sign-off.
import {
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
  EMAIL_LOGO_URL,
  EMAIL_PIXEL_WORDMARK_URL,
  escapeHtml,
} from "@traceroot/core";
import { clientEnv } from "@/env.client";
import {
  WELCOME_SUBJECT,
  greeting,
  optOutLine,
  optOutLineHtml,
  welcomeBody,
  WELCOME_SIGNOFF,
  LINK_STYLE,
} from "./copy";

const FIRST_NAME = /^\p{Script=Latin}[\p{Script=Latin}'’-]{0,39}$/u;
const LINK = /\[([^\]]+)\]\(([^\s]+)\)/g;
const toText = (paragraph: string) => paragraph.replace(LINK, "$1 ($2)");

// First token, exactly as the user typed it, when it looks like a Latin-script given name; otherwise null and the greeting is "Hi,".
export function displayFirstName(name: string | null | undefined): string | null {
  const token = name?.trim().split(/\s+/)[0] ?? "";
  if (!token || !FIRST_NAME.test(token)) return null;
  return token;
}

export interface RenderWelcomeInput {
  firstName: string | null;
  appUrl: string;
  unsubscribeUrl: string;
}

export function renderWelcome(input: RenderWelcomeInput): {
  subject: string;
  text: string;
  html: string;
} {
  const body = welcomeBody({
    appUrl: input.appUrl,
    docsUrl: clientEnv.NEXT_PUBLIC_DOCS_URL,
    githubUrl: clientEnv.NEXT_PUBLIC_GITHUB_REPO_URL,
  });
  const textLines = [
    greeting(input.firstName),
    "",
    body.map(toText).join("\n\n"),
    "",
    ...WELCOME_SIGNOFF,
    "",
    optOutLine(input.unsubscribeUrl),
  ];

  const inline = (s: string) =>
    escapeHtml(s)
      .replace(LINK, `<a href="$2" ${LINK_STYLE}>$1</a>`)
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  // Lines after the first that start with "- " become a list under the lead line.
  const toHtml = (paragraph: string) => {
    const [lead, ...items] = paragraph.split("\n- ");
    const list = items.map((item) => `<li>${inline(item)}</li>`).join("");
    return `<p>${inline(lead)}</p>` + (list ? `<ul>${list}</ul>` : "");
  };

  const htmlParts = [
    `<p style="margin:0 0 28px"><img src="${EMAIL_PIXEL_WORDMARK_URL}" alt="" width="480" height="77" style="display:block;border:0;width:100%;max-width:480px;height:auto"></p>`,
    `<p>${escapeHtml(greeting(input.firstName))}</p>`,
    ...body.map(toHtml),
    `<p>${WELCOME_SIGNOFF.map(escapeHtml).join("<br>")}</p>`,
    `<p style="margin:20px 0 0"><img src="${EMAIL_LOGO_URL}" alt="TraceRoot" width="106" height="20" style="display:block;border:0;width:106px;height:20px"></p>`,
    `<p style="margin-top:32px;font-size:12px;color:${EMAIL_COLORS.muted}">${optOutLineHtml(escapeHtml(input.unsubscribeUrl))}</p>`,
  ];

  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"></head>',
    `<body style="margin:0;padding:24px 16px;font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:1.6;color:${EMAIL_COLORS.ink}">`,
    '<div style="max-width:560px;margin:0 auto">',
    ...htmlParts,
    "</div>",
    "</body></html>",
  ].join("\n");

  return { subject: WELCOME_SUBJECT, text: textLines.join("\n"), html };
}
