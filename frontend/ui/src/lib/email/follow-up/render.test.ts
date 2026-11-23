import { describe, expect, it } from "vitest";
import { renderFollowUp } from "./render";

const LINKS = {
  setupUrl: "https://app.traceroot.ai/projects/p1/traces",
  demoUrl: "https://app.traceroot.ai/projects/demo/traces",
  integrationsUrl: "https://app.traceroot.ai/workspaces/w1/settings/integrations",
  bookingUrl: "https://cal.com/traceroot/30min",
};
const UNSUB = "https://app.traceroot.ai/api/email/unsubscribe?t=abc";
const render = (
  campaign: Parameters<typeof renderFollowUp>[0]["campaign"],
  firstName: string | null = "Kai",
) => renderFollowUp({ campaign, firstName, links: LINKS, unsubscribeUrl: UNSUB });

const SIGNOFF = "Best,\nXinwei He\nTraceRoot.AI | CEO";
const OPT_OUT = `If you don't want to hear from us again, let us know: ${UNSUB}`;

describe("the follow-up emails, as approved", () => {
  it("Setup help", () => {
    const { subject, text, html } = render("setup_help");
    expect(subject).toBe("Stuck on setup?");
    expect(text).toBe(
      [
        "Hi Kai,",
        "",
        "Your project has not received a trace yet. Setup is one command, run in the project you want to trace:",
        "",
        "    npx -y traceroot-cli@latest setup",
        "",
        "If that did not work, the setup page has the manual steps for your framework.",
        "",
        `Open setup: ${LINKS.setupUrl}`,
        "",
        "Or reply with your framework and the step where it stopped. Please leave API keys out of your reply.",
        "",
        `Prefer to do it together? Pick a time (${LINKS.bookingUrl}) and we will set it up on a call.`,
        "",
        SIGNOFF,
        "",
        OPT_OUT,
      ].join("\n"),
    );
    expect(html).toContain(`href="${LINKS.setupUrl}"`);
    expect(html).toContain(">Open setup</a>");
    expect(html).toContain(`<a href="${LINKS.bookingUrl}"`);
    expect(html).toContain("<code>npx -y traceroot-cli@latest setup</code>");
  });

  it("Last note", () => {
    const { subject, text } = render("last_note");
    expect(subject).toBe("One last note on setup");
    expect(text).toContain("This is the last email we will send about setup.");
    expect(text).toContain(
      "If now is not the time, the demo project stays open and shows what a traced agent looks like.",
    );
    expect(text).toContain(`Open the demo project: ${LINKS.demoUrl}`);
    expect(text).toContain(
      "If something blocked you, reply with one line. It tells us what to fix.",
    );
  });

  it("Slack and GitHub, without the opening sentence that is still to be chosen", () => {
    const { subject, text, html } = render("connect_slack_github");
    expect(subject).toBe("Get findings where your team works");
    expect(text).toContain(
      "Connect Slack and each finding is posted to a channel. Connect GitHub and a finding links to the code that produced it.",
    );
    expect(text).toContain(`Connect Slack and GitHub: ${LINKS.integrationsUrl}`);
    expect(text.toLowerCase()).not.toContain("detector");
    expect(html.toLowerCase()).not.toContain("detector");
  });

  it("First eval", () => {
    const { subject, text } = render("first_eval");
    expect(subject).toBe("Check a change before you ship it");
    expect(text).toContain(
      "When you change a prompt, a model or a tool, run the same cases before and after.",
    );
    expect(text).toContain(
      "An eval takes a small set of cases and shows which got better and which got worse.",
    );
    expect(text).toContain("Run your first eval: https://traceroot.ai/docs/evals/get-started");
  });
});

describe("every follow-up", () => {
  it.each(["setup_help", "last_note", "connect_slack_github", "first_eval"] as const)(
    "%s has one button, the founder's sign-off and the opt-out link",
    (campaign) => {
      const { text, html } = render(campaign);
      expect(html.match(/border-radius:6px"><a /g) ?? []).toHaveLength(1);
      expect(text).toContain(SIGNOFF);
      expect(text.endsWith(OPT_OUT)).toBe(true);
      expect(html).toContain(`<a href="${UNSUB}"`);
      expect(html).toContain("Best,<br>Xinwei He<br>TraceRoot.AI | CEO");
      expect(`${text}${html}`).not.toContain("Founder");
    },
  );

  it("greets without a name when there is none to use", () => {
    expect(render("first_eval", null).text.startsWith("Hi,\n")).toBe(true);
  });

  it("escapes what it puts in the HTML", () => {
    const { html } = renderFollowUp({
      campaign: "setup_help",
      firstName: "Kai",
      links: { ...LINKS, setupUrl: 'https://x.test/?a="b"&c=<d>' },
      unsubscribeUrl: UNSUB,
    });
    expect(html).toContain("https://x.test/?a=&quot;b&quot;&amp;c=&lt;d&gt;");
  });
});
