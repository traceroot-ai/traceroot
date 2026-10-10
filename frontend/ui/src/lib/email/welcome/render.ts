// Renders the welcome as text and HTML. Deliberately not the card template: the
// welcome reads as a short note, so the HTML is a few paragraphs, one list and links.
import { escapeHtml } from "@traceroot/core";
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

const FIRST_NAME = /^[A-Za-z][A-Za-z'’-]{0,39}$/;
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
    `<p>${escapeHtml(greeting(input.firstName))}</p>`,
    ...body.map(toHtml),
    `<p>${WELCOME_SIGNOFF.map(escapeHtml).join("<br>")}</p>`,
    `<p>${optOutLineHtml(escapeHtml(input.unsubscribeUrl))}</p>`,
  ];

  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"></head>',
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">',
    ...htmlParts,
    "</body></html>",
  ].join("\n");

  return { subject: WELCOME_SUBJECT, text: textLines.join("\n"), html };
}
