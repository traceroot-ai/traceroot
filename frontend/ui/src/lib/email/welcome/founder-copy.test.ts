import { describe, expect, it } from "vitest";
import { renderFounderEmail } from "../founder-email";
import { founderWelcomeCopy, type FounderWelcomeInput } from "./founder-copy";

const BASE: FounderWelcomeInput = {
  variant: "generic",
  demoUrl: "https://app.traceroot.ai/projects/demo/traces",
  bookingUrl: "https://cal.com/traceroot/30min",
  githubUrl: "https://github.com/traceroot-ai/traceroot",
  followUpLine: true,
  slackInviteLine: true,
};
const UNSUB = "https://app.traceroot.ai/api/email/unsubscribe?t=abc";
const render = (overrides: Partial<FounderWelcomeInput> = {}, firstName: string | null = "Sam") =>
  renderFounderEmail(founderWelcomeCopy({ ...BASE, ...overrides }), {
    firstName,
    unsubscribeUrl: UNSUB,
  });
const SIGNOFF = "Best,\nXinwei He\nTraceRoot.AI | CEO";

const LINK = 'style="color:#0B1015;text-decoration:underline"';
const CALENDAR = `If you’d like a hand with setup, pick a time on my calendar (${BASE.bookingUrl}).`;
const FOLLOW_UPS =
  "Over the next few weeks we will send a few short emails on what to do after your first trace.";
const SLACK =
  "You’ll also get a separate email from Slack inviting you to a private channel with our team.";
const STAR = `Star traceroot on GitHub (${BASE.githubUrl})`;
const FOOTER = ["", SIGNOFF, "", `Unsubscribe from product emails: ${UNSUB}`];

describe("the cloud welcome email, as approved", () => {
  it("standard version, with both announcements", () => {
    const { subject, text, html } = render();
    expect(subject).toBe("Send your first trace");
    expect(text).toBe(
      [
        "Hi Sam,",
        "",
        "Welcome to traceroot. Open the project you want to trace and run `npx -y traceroot-cli@latest setup`. Once setup finishes, run your agent as you normally would.",
        "",
        "Open the trace from that run. You’ll see which tools your agent called and how long each step took.",
        "",
        "If you get stuck, reply and tell us which framework you’re using.",
        "",
        CALENDAR,
        "",
        FOLLOW_UPS,
        "",
        SLACK,
        "",
        STAR,
        ...FOOTER,
      ].join("\n"),
    );
    // Links only; the standard version has no button.
    expect(html).not.toContain("display:inline-block");
    expect(html).toContain(
      '<code style="padding:1px 4px;background:#F4F4F6;border-radius:4px;font-size:13px">npx -y traceroot-cli@latest setup</code>',
    );
    expect(html).toContain(`<a href="${BASE.githubUrl}" ${LINK}>Star traceroot on GitHub</a>`);
  });

  it("look-around version, with the demo project as its button", () => {
    const { subject, text, html } = render({ variant: "exploring" });
    expect(subject).toBe("A trace you can explore");
    expect(text).toBe(
      [
        "Hi Sam,",
        "",
        "Welcome to traceroot. I’d start with the demo project. Pick a trace and open a tool call to see what the agent sent and what came back.",
        "",
        `Open the demo project: ${BASE.demoUrl}`,
        "",
        "When you’re ready to try it on your own agent, run `npx -y traceroot-cli@latest setup` in your project.",
        "",
        CALENDAR,
        "",
        FOLLOW_UPS,
        "",
        SLACK,
        "",
        STAR,
        ...FOOTER,
      ].join("\n"),
    );
    expect(html).toContain(`<a href="${BASE.demoUrl}" style="display:inline-block`);
    expect(html).toContain(">Open the demo project</a>");
  });

  it.each(["generic", "exploring"] as const)(
    "%s: each announcement appears only with its switch",
    (variant) => {
      const none = render({ variant, followUpLine: false, slackInviteLine: false }).text;
      expect(none).not.toContain(FOLLOW_UPS);
      expect(none).not.toContain(SLACK);
      expect(none).toContain(`${CALENDAR}\n\n${STAR}`);
      const followUpsOnly = render({ variant, slackInviteLine: false }).text;
      expect(followUpsOnly).toContain(`${CALENDAR}\n\n${FOLLOW_UPS}\n\n${STAR}`);
      const slackOnly = render({ variant, followUpLine: false }).text;
      expect(slackOnly).toContain(`${CALENDAR}\n\n${SLACK}\n\n${STAR}`);
    },
  );

  it.each(["generic", "exploring"] as const)(
    "%s links the configured calendar once, in HTML and in text",
    (variant) => {
      const bookingUrl = "https://cal.example.com/team/intro";
      const { text, html } = render({ variant, bookingUrl });
      expect(text).toContain(`pick a time on my calendar (${bookingUrl}).`);
      expect(html).toContain(
        `If you’d like a hand with setup, <a href="${bookingUrl}" ${LINK}>pick a time on my calendar</a>.`,
      );
      expect(html.split(bookingUrl)).toHaveLength(2);
    },
  );

  it.each(["generic", "exploring"] as const)(
    "%s is signed by the founder, never the team, and links the unsubscribe page",
    (variant) => {
      const { text, html } = render({ variant });
      expect(text).toContain(SIGNOFF);
      expect(html).toContain("Best,<br>Xinwei He<br>TraceRoot.AI | CEO");
      expect(`${text}${html}`).not.toContain("Founder");
      expect(`${text}${html}`).not.toMatch(/devs/i);
      expect(html).toContain(`<a href="${UNSUB}" ${LINK}>Unsubscribe from product emails</a>`);
    },
  );

  it("greets without a name when there is none", () => {
    expect(render({}, null).text.startsWith("Hi,\n\nWelcome to traceroot.")).toBe(true);
  });
});
