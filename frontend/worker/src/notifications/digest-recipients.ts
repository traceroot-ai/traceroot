import { prisma } from "@traceroot/core";

export interface DigestRecipients {
  projectName: string;
  workspaceId: string;
  slackChannelId: string | null;
  encryptedBotToken: string | null;
  emailAddresses: string[];
  billingPlan: string;
  rcaBlocked: boolean;
  rcaModel: string | null;
  rcaProvider: string | null;
  rcaSource: string | null;
}

/**
 * Resolve the project's alert channels once, up front. Returns null when the
 * project is gone (or soft-deleted) or has nothing configured (no Slack channel + bot token, no
 * email recipients), so the caller can skip the rest of the flush for a digest
 * that would fan out to nowhere.
 */
export async function resolveRecipients(projectId: string): Promise<DigestRecipients | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deleteTime: null },
    select: {
      name: true,
      rcaModel: true,
      rcaProvider: true,
      rcaSource: true,
      alertConfig: { select: { emailAddresses: true, slackChannelId: true } },
      workspace: {
        select: {
          id: true,
          billingPlan: true,
          rcaBlocked: true,
          slackIntegration: { select: { channelId: true, botToken: true } },
        },
      },
    },
  });
  if (!project) return null;

  const slack = project.workspace?.slackIntegration ?? null;
  const slackChannelId = project.alertConfig?.slackChannelId ?? slack?.channelId ?? null;
  const slackReady = Boolean(slackChannelId && slack?.botToken);
  const emailAddresses = project.alertConfig?.emailAddresses ?? [];
  if (!slackReady && emailAddresses.length === 0) return null; // nowhere to send

  return {
    projectName: project.name,
    workspaceId: project.workspace!.id,
    slackChannelId: slackReady ? slackChannelId : null,
    encryptedBotToken: slackReady ? slack!.botToken : null,
    emailAddresses,
    billingPlan: (project.workspace?.billingPlan as string) ?? "free",
    rcaBlocked: project.workspace?.rcaBlocked ?? false,
    rcaModel: project.rcaModel,
    rcaProvider: project.rcaProvider,
    rcaSource: project.rcaSource,
  };
}
