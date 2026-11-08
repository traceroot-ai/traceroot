import { complete } from "@earendil-works/pi-ai/compat";
import { decryptKey, hasEntitlement, prisma, type PlanType } from "@traceroot/core";
import { createSlackClient } from "@traceroot/slack";
import { resolveRecipients } from "../notifications/digest-recipients.js";
import { sendEmail } from "../notifications/email.js";
import {
  aggregatesConfigFromEnv,
  readTraceSample,
  runBoundedSql,
  type AggregatesClientConfig,
} from "./aggregates-client.js";
import type { SlackPoster } from "./deliver.js";
import { resolveUpdateModel } from "./model.js";
import type { AgentStageDeps } from "./stage.js";

/** A Slack poster for a workspace's bot, or null when its plan has no Slack integration. */
async function slackPosterFor(
  workspaceId: string,
  encryptedBotToken: string,
): Promise<SlackPoster | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { billingPlan: true },
  });
  const plan = (workspace?.billingPlan ?? "free") as PlanType;
  if (!hasEntitlement(plan, "slack-integration")) return null;
  const client = createSlackClient(decryptKey(encryptedBotToken));
  return {
    async postHeadline(channelId, post) {
      const res = await client.chat.postMessage({
        channel: channelId,
        text: post.text,
        blocks: post.blocks as never,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!res.ok || !res.ts)
        throw new Error(`Slack did not accept the message: ${res.error ?? "no timestamp"}`);
      return res.ts;
    },
    async postInThread(channelId, threadTs, post) {
      const res = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: post.text,
        blocks: post.blocks as never,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!res.ok)
        throw new Error(`Slack did not accept the thread message: ${res.error ?? "unknown"}`);
    },
  };
}

/**
 * Development only: make the first email of each run fail, to watch a retry
 * resume without a second model call or a second message. Off unless
 * UPDATES_INJECT_FAULT=email-once, and never in production.
 */
/** Messages that have already failed once, kept for the life of the process so a retry gets through. */
const failedOnce = new Set<string>();

function faultyEmail(send: typeof sendEmail): typeof sendEmail {
  if (process.env.UPDATES_INJECT_FAULT !== "email-once" || process.env.NODE_ENV === "production") {
    return send;
  }
  return async (mail) => {
    const key = `${mail.to.join(",")}|${mail.subject}`;
    if (!failedOnce.has(key)) {
      failedOnce.add(key);
      throw new Error(
        "injected fault: the mail transport failed (UPDATES_INJECT_FAULT=email-once)",
      );
    }
    return send(mail);
  };
}

/** The agent, its tools and delivery wired to the real services. */
export function buildAgentStageDeps(
  config: AggregatesClientConfig = aggregatesConfigFromEnv(),
): AgentStageDeps {
  return {
    resolveModel: (project) => resolveUpdateModel(project),
    complete: complete as AgentStageDeps["complete"],
    log: process.env.UPDATE_AGENT_DEBUG
      ? (line) => console.log(`[Updates] agent ${line}`)
      : undefined,
    readSample: (projectId, run, seed) =>
      readTraceSample(config, projectId, run.windowStart, run.windowEnd, seed),
    runSql: (projectId, query) => runBoundedSql(config, projectId, query),
    delivery: {
      db: prisma,
      resolveRecipients: async (projectId) => {
        const r = await resolveRecipients(projectId);
        return r
          ? {
              workspaceId: r.workspaceId,
              slackChannelId: r.slackChannelId,
              encryptedBotToken: r.encryptedBotToken,
              emailAddresses: r.emailAddresses,
            }
          : null;
      },
      slackFor: slackPosterFor,
      sendEmail: faultyEmail(sendEmail),
    },
  };
}
