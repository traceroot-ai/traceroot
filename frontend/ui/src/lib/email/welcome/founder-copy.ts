/**
 * The cloud welcome email, as approved: two versions, both signed by the
 * founder (../founder-email.ts). The self-hosted install keeps the original
 * welcome email (./copy.ts), unchanged.
 */
import type { FounderEmailCopy } from "../founder-email";

export type WelcomeVariant = "generic" | "exploring";

export interface FounderWelcomeInput {
  /** "exploring" for someone whose only answer to "What will you use traceroot for?" was Just exploring. */
  variant: WelcomeVariant;
  /** The demo project, or the app when there is none. */
  demoUrl: string;
  bookingUrl: string;
  githubUrl: string;
  /** Only while the follow-up emails are being sent. */
  followUpLine: boolean;
  /** Only for someone who will get the Slack invite, while invites are on. */
  slackInviteLine: boolean;
}

export const WELCOME_SETUP_COMMAND = "npx -y traceroot-cli@latest setup";

export function founderWelcomeCopy(input: FounderWelcomeInput): FounderEmailCopy {
  const stuck = `Stuck on anything? Reply to this email and a person on the team will answer, or [pick a time](${input.bookingUrl}) and we will set it up together.`;
  const closing = [
    input.followUpLine
      ? `Over the next few weeks we will send a few short emails on what to do after your first trace. ${stuck}`
      : stuck,
    ...(input.slackInviteLine
      ? [
          "You will also get an invite from Slack to a private channel with our team. You can ask us anything there.",
        ]
      : []),
    `traceroot is open source. Don't forget to [star ⭐ our repo on GitHub](${input.githubUrl})!`,
  ];

  if (input.variant === "exploring") {
    return {
      subject: "Take a look around traceroot",
      paragraphs: [
        "Welcome to traceroot.",
        "You can see what it does before connecting anything. The demo project has real traces. Open one and follow each step the agent took.",
      ],
      button: { label: "Open the demo project", url: input.demoUrl },
      after: [
        "When you want it on your own agent, setup is one command, run in the project you want to trace:",
        `    ${WELCOME_SETUP_COMMAND}`,
        ...closing,
      ],
    };
  }
  return {
    subject: "Send your first trace to traceroot",
    paragraphs: [
      "Welcome to traceroot.",
      "Start by sending one trace. Run this in the project you want to trace and your coding agent adds the instrumentation:",
      `    ${WELCOME_SETUP_COMMAND}`,
      "When the trace arrives you can open it and see every step your agent took.",
      `Want to look around first? The [demo project](${input.demoUrl}) has real traces to click through.`,
      ...closing,
    ],
  };
}
