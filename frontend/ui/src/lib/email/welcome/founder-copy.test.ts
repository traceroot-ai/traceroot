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
const SIGNOFF = "Best,\nXinwei\nFounder, traceroot";

describe("the cloud welcome email, as approved", () => {
  it("generic version, with both preview lines", () => {
    const { subject, text } = render();
    expect(subject).toBe("Send your first trace to traceroot");
    expect(text).toBe(
      [
        "Hi Sam,",
        "",
        "Welcome to traceroot.",
        "",
        "Start by sending one trace. Run this in the project you want to trace and your coding agent adds the instrumentation:",
        "",
        "    npx -y traceroot-cli@latest setup",
        "",
        "When the trace arrives you can open it and see every step your agent took.",
        "",
        `Want to look around first? The demo project (${BASE.demoUrl}) has real traces to click through.`,
        "",
        `Over the next few weeks we will send a few short emails on what to do after your first trace. Stuck on anything? Reply to this email and a person on the team will answer, or pick a time (${BASE.bookingUrl}) and we will set it up together.`,
        "",
        "You will also get an invite from Slack to a private channel with our team. You can ask us anything there.",
        "",
        `traceroot is open source. Don't forget to star ⭐ our repo on GitHub (${BASE.githubUrl})!`,
        "",
        SIGNOFF,
        "",
        `If you don't want to hear from us again, let us know: ${UNSUB}`,
      ].join("\n"),
    );
  });

  it("Just exploring version, with the demo project as its button", () => {
    const { subject, text, html } = render({ variant: "exploring" });
    expect(subject).toBe("Take a look around traceroot");
    expect(text).toContain(
      "You can see what it does before connecting anything. The demo project has real traces. Open one and follow each step the agent took.",
    );
    expect(text).toContain(`Open the demo project: ${BASE.demoUrl}`);
    expect(text).toContain(
      "When you want it on your own agent, setup is one command, run in the project you want to trace:",
    );
    expect(text).toContain(SIGNOFF);
    expect(html).toContain(`>Open the demo project</a>`);
  });

  it.each(["generic", "exploring"] as const)(
    "%s: without the follow-ups running or an invite coming, keeps the offer of help and leaves out the promises",
    (variant) => {
      const { text } = render({ variant, followUpLine: false, slackInviteLine: false });
      expect(text).toContain(
        `Stuck on anything? Reply to this email and a person on the team will answer, or pick a time (${BASE.bookingUrl}) and we will set it up together.`,
      );
      expect(text).not.toContain("Over the next few weeks");
      expect(text).not.toContain("invite from Slack");
    },
  );

  it.each(["generic", "exploring"] as const)(
    "%s is signed by the founder, never the team, and links the unsubscribe page",
    (variant) => {
      const { text, html } = render({ variant });
      expect(text).toContain(SIGNOFF);
      expect(html).toContain("Best,<br>Xinwei<br>Founder, traceroot");
      expect(`${text}${html}`).not.toMatch(/devs/i);
      expect(html).toContain(`<a href="${UNSUB}"`);
    },
  );
});
