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
}

export async function sendDigestAlertSlack(params: SendDigestAlertSlackParams): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { billingPlan: true },
  });
  const plan = (workspace?.billingPlan ?? "free") as PlanType;
  if (!hasEntitlement(plan, "slack-integration")) {
    console.log(
      `[slack] Skipping digest for workspace ${params.workspaceId}: plan "${plan}" lacks slack-integration entitlement`,
    );
    return;
  }

  const client = createSlackClient(decryptKey(params.encryptedBotToken));
  const blocks = buildDigestAlertBlocks({
    projectId: params.projectId,
    projectName: params.projectName,
    appBaseUrl: APP_BASE_URL,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    total: params.total,
    entries: params.entries,
  });
  await client.chat.postMessage({
    channel: params.channelId,
    blocks: blocks as any,
    text: `Alert digest: ${params.total} findings on ${params.projectName}`,
    unfurl_links: false,
    unfurl_media: false,
  });
}
