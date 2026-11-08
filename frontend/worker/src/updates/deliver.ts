import type { PrismaClient } from "@traceroot/core";
import type { UpdateResult } from "@traceroot/core/updates";
import { renderEmail, renderSlack, type RenderContext } from "./render.js";

/**
 * Deliver one run's result to Slack and email.
 *
 * Each channel records its own success on the run, after the channel accepted
 * the message. A retry therefore sends only to the channel that has not
 * received it: it never re-runs the agent and never re-sends to a channel
 * that already holds the message. Slack goes in three steps (headline, then
 * thread posts), and the headline's timestamp and the number of thread posts
 * are kept as they happen, so a failure part way resumes where it stopped.
 */

export interface Recipients {
  workspaceId: string;
  slackChannelId: string | null;
  encryptedBotToken: string | null;
  emailAddresses: string[];
}

export interface SlackPoster {
  /** Post the headline to the channel; returns its timestamp. */
  postHeadline(channelId: string, post: { text: string; blocks: unknown[] }): Promise<string>;
  postInThread(
    channelId: string,
    threadTs: string,
    post: { text: string; blocks: unknown[] },
  ): Promise<void>;
}

export interface DeliveryDeps {
  db: Pick<PrismaClient, "projectUpdateRun">;
  resolveRecipients: (projectId: string) => Promise<Recipients | null>;
  /** A poster for the workspace's bot; null when the plan has no Slack integration. */
  slackFor: (workspaceId: string, encryptedBotToken: string) => Promise<SlackPoster | null>;
  /** Returns false when no mail transport is configured. */
  sendEmail: (mail: {
    to: string[];
    subject: string;
    text: string;
    html: string;
  }) => Promise<boolean>;
  log?: (message: string) => void;
}

export interface DeliveryRun {
  id: string;
  projectId: string;
  slackDeliveredAt: Date | null;
  slackMessageTs: string | null;
  slackThreadPosts: number;
  emailDeliveredAt: Date | null;
}

export interface DeliveryOutcome {
  /** True when every channel that is configured and available has the message. */
  complete: boolean;
  notes: string[];
  slack: "sent" | "already" | "skipped";
  email: "sent" | "already" | "skipped";
}

export async function deliverRun(
  deps: DeliveryDeps,
  run: DeliveryRun,
  result: UpdateResult,
  ctx: RenderContext,
): Promise<DeliveryOutcome> {
  const log = deps.log ?? ((m: string) => console.log(`[Updates] ${m}`));
  const notes: string[] = [];
  const outcome: DeliveryOutcome = { complete: true, notes, slack: "skipped", email: "skipped" };

  const recipients = await deps.resolveRecipients(run.projectId);
  if (!recipients) {
    notes.push("No Slack channel or email recipients are configured for this project.");
    log(`delivery skipped run=${run.id}: no channels`);
    return outcome;
  }

  // Slack
  if (recipients.slackChannelId && recipients.encryptedBotToken) {
    if (run.slackDeliveredAt) {
      outcome.slack = "already";
    } else {
      const poster = await deps.slackFor(recipients.workspaceId, recipients.encryptedBotToken);
      if (!poster) {
        notes.push("Slack skipped: this workspace's plan does not include the Slack integration.");
      } else {
        const rendering = renderSlack(result, ctx);
        let ts = run.slackMessageTs;
        if (!ts) {
          ts = await poster.postHeadline(recipients.slackChannelId, rendering.headline);
          await deps.db.projectUpdateRun.update({
            where: { id: run.id },
            data: { slackMessageTs: ts },
          });
        }
        let posted = run.slackThreadPosts;
        for (let i = posted; i < rendering.thread.length; i += 1) {
          await poster.postInThread(recipients.slackChannelId, ts, rendering.thread[i]);
          posted = i + 1;
          await deps.db.projectUpdateRun.update({
            where: { id: run.id },
            data: { slackThreadPosts: posted },
          });
        }
        await deps.db.projectUpdateRun.update({
          where: { id: run.id },
          data: { slackDeliveredAt: new Date() },
        });
        outcome.slack = "sent";
      }
    }
  }

  // Email
  if (recipients.emailAddresses.length > 0) {
    if (run.emailDeliveredAt) {
      outcome.email = "already";
    } else {
      const mail = renderEmail(result, ctx);
      const sent = await deps.sendEmail({ to: recipients.emailAddresses, ...mail });
      if (!sent) {
        notes.push("Email skipped: no mail transport is configured (set TRACEROOT_SMTP_URL).");
        log(`email skipped run=${run.id}: SMTP not configured`);
      } else {
        await deps.db.projectUpdateRun.update({
          where: { id: run.id },
          data: { emailDeliveredAt: new Date() },
        });
        outcome.email = "sent";
      }
    }
  }
  return outcome;
}
