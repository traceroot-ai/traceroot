/**
 * The four follow-up emails, word for word as approved, apart from the one
 * sentence still open (see `connect_slack_github`). Each is the greeting, a few
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
}

export type FollowUpCopy = FounderEmailCopy;

export const SETUP_COMMAND = "npx -y traceroot-cli@latest setup";
export const EVALS_DOCS_URL = "https://traceroot.ai/docs/evals/get-started";

export function followUpCopy(campaign: FollowUp, links: FollowUpLinks): FollowUpCopy {
  switch (campaign) {
    case "setup_help":
      return {
        subject: "Stuck on setup?",
        paragraphs: [
          "Your project has not received a trace yet. Setup is one command, run in the project you want to trace:",
          `    ${SETUP_COMMAND}`,
          "If that did not work, the setup page has the manual steps for your framework.",
        ],
        button: { label: "Open setup", url: links.setupUrl },
        after: [
          "Or reply with your framework and the step where it stopped. Please leave API keys out of your reply.",
          `Prefer to do it together? [Pick a time](${links.bookingUrl}) and we will set it up on a call.`,
        ],
      };
    case "last_note":
      return {
        subject: "One last note on setup",
        paragraphs: [
          "This is the last email we will send about setup.",
          "If now is not the time, the demo project stays open and shows what a traced agent looks like.",
        ],
        button: { label: "Open the demo project", url: links.demoUrl },
        after: ["If something blocked you, reply with one line. It tells us what to fix."],
      };
    case "connect_slack_github":
      // The approved draft opens with a sentence about detectors, which are now
      // optional; its replacement is still to be chosen, so the email starts at
      // the second paragraph until then.
      return {
        subject: "Get findings where your team works",
        paragraphs: [
          "Connect Slack and each finding is posted to a channel. Connect GitHub and a finding links to the code that produced it.",
        ],
        button: { label: "Connect Slack and GitHub", url: links.integrationsUrl },
      };
    case "first_eval":
      return {
        subject: "Check a change before you ship it",
        paragraphs: [
          "When you change a prompt, a model or a tool, run the same cases before and after.",
          "An eval takes a small set of cases and shows which got better and which got worse.",
        ],
        button: { label: "Run your first eval", url: EVALS_DOCS_URL },
      };
  }
}
