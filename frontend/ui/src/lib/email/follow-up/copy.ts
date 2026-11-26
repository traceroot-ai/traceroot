/**
 * The four follow-up emails, word for word as approved. Each is the greeting, a few
 * paragraphs, at most one button, the founder's sign-off and the opt-out line
 * (../founder-email.ts).
 *
 * In a paragraph, `[label](url)` is a link and an indented line is a command.
 */
import type { FollowUp } from "@/lib/lifecycle/follow-up";
import type { FounderEmailCopy } from "../founder-email";

export interface FollowUpLinks {
  /** The person's setup page: their earliest project's traces, or onboarding. */
  setupUrl: string;
  /** The demo project, or the app when there is none. */
  demoUrl: string;
  /** Integration settings of the person's own workspace. */
  integrationsUrl: string;
  /** Booking a call. */
  bookingUrl: string;
  /**
   * The open signals in one project the person can open, and that project's
   * Signals page; only for Slack and GitHub, and only when there are some.
   */
  openSignals?: { count: number; url: string };
}

export type FollowUpCopy = FounderEmailCopy;

export const EVALS_DOCS_URL = "https://traceroot.ai/docs/evals/get-started";

/** The one-line reminder of a project's open signals, linked to them. */
export function openSignalsLine({ count, url }: { count: number; url: string }): string {
  return count === 1
    ? `[1 open signal](${url}) is waiting in your project.`
    : `[${count} open signals](${url}) are waiting in your project.`;
}

export function followUpCopy(campaign: FollowUp, links: FollowUpLinks): FollowUpCopy {
  switch (campaign) {
    case "setup_help":
      return {
        subject: "Where did setup get stuck?",
        paragraphs: [
          "If you’ve tried setup and your trace hasn’t appeared, reply with your framework and the step where it stopped. Please leave out any API keys.",
          "If you’d rather set it up by hand, the setup page has the steps for your framework.",
        ],
        button: { label: "Open setup", url: links.setupUrl },
        after: [
          `Prefer to do it together? [Pick a time](${links.bookingUrl}) and we will set it up on a call.`,
        ],
      };
    case "last_note":
      return {
        subject: "One last note on setup",
        paragraphs: [
          "I’ll leave setup here. If you’d still like to see what a traced agent looks like, you can open a real run in the demo project.",
        ],
        button: { label: "Open the demo project", url: links.demoUrl },
      };
    case "connect_slack_github":
      return {
        subject: "Connect your team’s tools",
        paragraphs: [
          "You can choose a Slack channel for alerts and connect the GitHub repo your agent runs from. Both settings are in your workspace.",
        ],
        button: { label: "Open integrations", url: links.integrationsUrl },
        ...(links.openSignals && { after: [openSignalsLine(links.openSignals)] }),
      };
    case "first_eval":
      return {
        subject: "Try an eval on one change",
        paragraphs: [
          "Next time you change a prompt or a model, pick a few cases you care about and run them before and after the change. The guide walks you through your first comparison.",
        ],
        button: { label: "Run your first eval", url: EVALS_DOCS_URL },
      };
  }
}
