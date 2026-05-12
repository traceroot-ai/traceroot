import { createSlackClient, buildCombinedAlertBlocks } from "@traceroot/slack";
import { decryptKey, hasEntitlement, prisma, type PlanType } from "@traceroot/core";

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export interface SendCombinedAlertSlackParams {
  workspaceId: string;
  encryptedBotToken: string;
  channelId: string;
  detectorName: string;
  projectName: string;
  summary: string;
  traceId: string;
  projectId: string;
  rcaResult: string | null;
}

export async function sendCombinedAlertSlack(params: SendCombinedAlertSlackParams): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { billingPlan: true },
  });
  const plan = (workspace?.billingPlan ?? "free") as PlanType;
  if (!hasEntitlement(plan, "slack-integration")) {
    console.log(
      `[slack] Skipping Slack alert for workspace ${params.workspaceId}: plan "${plan}" lacks slack-integration entitlement`,
    );
    return;
  }

  const client = createSlackClient(decryptKey(params.encryptedBotToken));
  const blocks = buildCombinedAlertBlocks({
    detectorName: params.detectorName,
    projectName: params.projectName,
    summary: params.summary,
    traceId: params.traceId,
    projectId: params.projectId,
    appBaseUrl: APP_BASE_URL,
    rcaResult: params.rcaResult,
  });
  await client.chat.postMessage({
    channel: params.channelId,
    blocks: blocks as any,
    text: `Alert: ${params.detectorName} fired on ${params.projectName}`,
    unfurl_links: false,
    unfurl_media: false,
  });
}
