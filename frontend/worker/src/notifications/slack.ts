import { createSlackClient, buildDigestAlertBlocks, type DigestEntry } from "@traceroot/slack";
import { decryptKey, hasEntitlement, prisma, type PlanType } from "@traceroot/core";

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export interface SendDigestAlertSlackParams {
  workspaceId: string;
  encryptedBotToken: string;
  channelId: string;
  projectId: string;
  projectName: string;
  windowStart: Date;
  windowEnd: Date;
  total: number;
  entries: DigestEntry[];
  /** Optional LLM-written paragraph; escaped + capped by the block builder. */
  summary?: string;
}

/**
 * Post a message with the workspace's bot, if its plan includes the Slack
 * integration. Returns false when the plan does not.
 */
export async function postSlackMessage(params: {
  workspaceId: string;
  encryptedBotToken: string;
  channelId: string;
  blocks: unknown[];
  text: string;
}): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { billingPlan: true },
  });
  const plan = (workspace?.billingPlan ?? "free") as PlanType;
  if (!hasEntitlement(plan, "slack-integration")) {
    console.log(
      `[slack] Skipping digest for workspace ${params.workspaceId}: plan "${plan}" lacks slack-integration entitlement`,
    );
    return false;
  }
  const client = createSlackClient(decryptKey(params.encryptedBotToken));
  await client.chat.postMessage({
    channel: params.channelId,
    blocks: params.blocks as any,
    text: params.text,
    unfurl_links: false,
    unfurl_media: false,
  });
  return true;
}

export async function sendDigestAlertSlack(params: SendDigestAlertSlackParams): Promise<void> {
  const blocks = buildDigestAlertBlocks({
    projectId: params.projectId,
    projectName: params.projectName,
    appBaseUrl: APP_BASE_URL,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    total: params.total,
    entries: params.entries,
    summary: params.summary,
  });
  await postSlackMessage({
    workspaceId: params.workspaceId,
    encryptedBotToken: params.encryptedBotToken,
    channelId: params.channelId,
    blocks,
    text: `Alert digest: ${params.total} findings on ${params.projectName}`,
  });
}
