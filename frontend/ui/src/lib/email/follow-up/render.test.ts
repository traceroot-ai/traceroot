import { describe, expect, it } from "vitest";
import { renderFollowUp } from "./render";

const LINKS = {
  setupUrl: "https://app.traceroot.ai/projects/p1/traces",
  demoUrl: "https://app.traceroot.ai/demo",
  integrationsUrl: "https://app.traceroot.ai/workspaces/w1/settings/integrations",
  bookingUrl: "https://cal.com/traceroot/30min",
};
const UNSUB = "https://app.traceroot.ai/api/email/unsubscribe?t=abc";
const render = (
  campaign: Parameters<typeof renderFollowUp>[0]["campaign"],
  firstName: string | null = "Kai",
) => renderFollowUp({ campaign, firstName, links: LINKS, unsubscribeUrl: UNSUB });

const SIGNOFF = "Best,\nXinwei He\ntraceroot | CEO";
const OPT_OUT = `Unsubscribe from product emails: ${UNSUB}`;

/** The plain text of one email: greeting, body, sign-off and opt-out. */
const email = (...body: string[]) =>
  ["Hi Kai,", "", body.join("\n\n"), "", SIGNOFF, "", OPT_OUT].join("\n");

describe("the follow-up emails, as approved", () => {
  it("Setup help", () => {
    const { subject, text, html } = render("setup_help");
    expect(subject).toBe("Where did setup get stuck?");
    expect(text).toBe(
      email(
        "If you’ve tried setup and your trace hasn’t appeared, reply with your framework and the step where it stopped. Please leave out any API keys.",
        "If you’d rather set it up by hand, the setup page has the steps for your framework.",
        `Open setup: ${LINKS.setupUrl}`,
        `Prefer to do it together? Pick a time (${LINKS.bookingUrl}) and we will set it up on a call.`,
      ),
    );
    expect(html).toContain(`<a href="${LINKS.setupUrl}" style="display:inline-block`);
    expect(html).toContain(">Open setup</a>");
    expect(html).toContain(
      `<a href="${LINKS.bookingUrl}" style="color:#0B1015;text-decoration:underline">Pick a time</a>`,
    );
  });

  it("Last note", () => {
    const { subject, text, html } = render("last_note");
    expect(subject).toBe("One last note on setup");
    expect(text).toBe(
      email(
        "I’ll leave setup here. If you’d still like to see what a traced agent looks like, you can open a real run in the demo project.",
        `Open the demo project: ${LINKS.demoUrl}`,
      ),
    );
    expect(html).toContain(`<a href="${LINKS.demoUrl}" style="display:inline-block`);
  });

  it("Slack and GitHub", () => {
    const { subject, text, html } = render("connect_slack_github");
    expect(subject).toBe("Connect your team’s tools");
    expect(text).toBe(
      email(
        "You can choose a Slack channel for alerts and connect the GitHub repo your agent runs from. Both settings are in your workspace.",
        `Open integrations: ${LINKS.integrationsUrl}`,
      ),
    );
    expect(html).toContain(`<a href="${LINKS.integrationsUrl}" style="display:inline-block`);
  });

  it("Slack and GitHub, with the open-signals line after the button", () => {
    const signals = "https://app.traceroot.ai/projects/p1/signals?from=email-open-signals";
    const one = renderFollowUp({
      campaign: "connect_slack_github",
      firstName: "Kai",
      links: { ...LINKS, openSignals: { count: 1, url: signals } },
      unsubscribeUrl: UNSUB,
    });
    expect(one.text).toBe(
      email(
        "You can choose a Slack channel for alerts and connect the GitHub repo your agent runs from. Both settings are in your workspace.",
        `Open integrations: ${LINKS.integrationsUrl}`,
        `1 open signal (${signals}) is waiting in your project.`,
      ),
    );
    expect(one.html).toContain(
      `<p style="margin:16px 0 0;font-size:16px;line-height:25px"><a href="${signals}" style="color:#0B1015;text-decoration:underline">1 open signal</a> is waiting in your project.</p>`,
    );
    expect(one.html.indexOf(">Open integrations</a>")).toBeLessThan(
      one.html.indexOf("1 open signal"),
    );
    const many = renderFollowUp({
      campaign: "connect_slack_github",
      firstName: "Kai",
      links: { ...LINKS, openSignals: { count: 12, url: signals } },
      unsubscribeUrl: UNSUB,
    });
    expect(many.text).toContain(`12 open signals (${signals}) are waiting in your project.`);
  });

  it.each(["setup_help", "last_note", "first_eval"] as const)(
    "%s never carries the open-signals line",
    (campaign) => {
      const { text, html } = renderFollowUp({
        campaign,
        firstName: "Kai",
        links: { ...LINKS, openSignals: { count: 2, url: "https://app.traceroot.ai/x/signals" } },
        unsubscribeUrl: UNSUB,
      });
      expect(`${text}${html}`).not.toContain("open signal");
    },
  );

  it("First eval", () => {
    const { subject, text, html } = render("first_eval");
    expect(subject).toBe("Try an eval on one change");
    expect(text).toBe(
      email(
        "Next time you change a prompt or a model, pick a few cases you care about and run them before and after the change. The guide walks you through your first comparison.",
        "Run your first eval: https://traceroot.ai/docs/evals/get-started",
      ),
    );
    expect(html).toContain(
      '<a href="https://traceroot.ai/docs/evals/get-started" style="display:inline-block',
    );
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
      expect(html).toContain(
        `<a href="${UNSUB}" style="color:#5F646B;text-decoration:underline">Unsubscribe from product emails</a>`,
      );
      expect(html).toContain("Best,<br>Xinwei He<br>traceroot | CEO");
      // One wordmark, at the top; no second logo by the signature.
      expect(html.match(/<img /g) ?? []).toHaveLength(1);
      // The provider fills the postal address in, under the opt-out line.
      expect(html.indexOf("<!--traceroot:postal-address-->")).toBeGreaterThan(
        html.indexOf("Unsubscribe from product emails"),
      );
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
