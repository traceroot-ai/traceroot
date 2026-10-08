export const WELCOME_SUBJECT = "Making the most of TraceRoot";

export function greeting(firstName: string | null): string {
  return firstName ? `Hi ${firstName},` : "Hi,";
}

export interface WelcomeLinks {
  appUrl: string;
  docsUrl: string;
  githubUrl: string;
}

/** Paragraphs; `[label](url)` marks a link, `backticks` mark code and "- " lines make a list. */
export function welcomeBody({ appUrl, docsUrl, githubUrl }: WelcomeLinks): string[] {
  return [
    "Welcome to TraceRoot!",
    [
      "TraceRoot runs inside your coding agent. A few things to try now:",
      "- Install the CLI: `npm install -g traceroot-cli` → `traceroot login`",
      "- Ask your agent to set up tracing for your project",
      `- Prefer a UI? The [web app](${appUrl}) and [docs](${docsUrl}) are always there`,
    ].join("\n"),
    `TraceRoot is open source. Don't forget to [star ⭐ our repo on GitHub](${githubUrl})!`,
  ];
}

export const WELCOME_SIGNOFF = ["Best,", "The TraceRoot Devs"];

export function optOutLine(url: string): string {
  return `If you don't want to hear from us again, let us know: ${url}`;
}

/** Same sentence with "let us know" as the link; `url` must already be safe for an attribute. */
export function optOutLineHtml(url: string): string {
  return `If you don't want to hear from us again, <a href="${url}">let us know</a>.`;
}
