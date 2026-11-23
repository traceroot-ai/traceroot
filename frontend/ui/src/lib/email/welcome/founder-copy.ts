/**
 * The cloud welcome email, as approved: two versions, both signed by the
 * founder (../founder-email.ts). The self-hosted install keeps the original
 * welcome email (./copy.ts), unchanged.
 */
import type { FounderEmailCopy } from "../founder-email";

/** "exploring" is the look-around version, for someone just looking around for now. */
export type WelcomeVariant = "generic" | "exploring";

export interface FounderWelcomeInput {
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
  const closing = [
    `If you’d like a hand with setup, [pick a time on my calendar](${input.bookingUrl}).`,
    ...(input.followUpLine
      ? [
          "Over the next few weeks we will send a few short emails on what to do after your first trace.",
        ]
      : []),
    ...(input.slackInviteLine
      ? [
          "You’ll also get a separate email from Slack inviting you to a private channel with our team.",
        ]
      : []),
    `[Star traceroot on GitHub](${input.githubUrl})`,
  ];

  if (input.variant === "exploring") {
    return {
      subject: "A trace you can explore",
      paragraphs: [
        "Welcome to traceroot. I’d start with the demo project. Pick a trace and open a tool call to see what the agent sent and what came back.",
      ],
      button: { label: "Open the demo project", url: input.demoUrl },
      after: [
        `When you’re ready to try it on your own agent, run \`${WELCOME_SETUP_COMMAND}\` in your project.`,
        ...closing,
      ],
    };
  }
  return {
    subject: "Send your first trace",
    paragraphs: [
      `Welcome to traceroot. Open the project you want to trace and run \`${WELCOME_SETUP_COMMAND}\`. Once setup finishes, run your agent as you normally would.`,
      "Open the trace from that run. You’ll see which tools your agent called and how long each step took.",
      "If you get stuck, reply and tell us which framework you’re using.",
      ...closing,
    ],
  };
}
