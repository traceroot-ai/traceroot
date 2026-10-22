// Where an alert rule's Slack messages go. Shared by the worker, which sends pages
// and the closes of edits and resumes, and the web app, which sends the close of a
// delete itself.

import { hasEntitlement, prisma, type PlanType } from "@traceroot/core";

export interface AlertSlackTarget {
  channelId: string;
  encryptedBotToken: string;
}

export type AlertChannelResolution =
  | { ok: true; target: AlertSlackTarget }
  | { ok: false; reason: string };

/**
 * A project-level channel overrides the workspace default, matching the detector
 * digest. Every miss carries a reason: a send that quietly does nothing is invisible.
 */
export async function resolveAlertChannel(projectId: string): Promise<AlertChannelResolution> {
  // Re-checked at send, not just at claim time: a deleted project must not be linked to in Slack.
  const project = await prisma.project.findUnique({
    where: { id: projectId, deleteTime: null },
    select: {
      alertConfig: { select: { slackChannelId: true } },
      workspace: {
        select: {
          billingPlan: true,
          slackIntegration: { select: { channelId: true, botToken: true } },
        },
      },
    },
  });
  if (!project) return { ok: false, reason: "project-missing" };

  const plan = (project.workspace?.billingPlan ?? "free") as PlanType;
  if (!hasEntitlement(plan, "slack-integration")) {
    return { ok: false, reason: `no-entitlement plan=${plan}` };
  }

  const slack = project.workspace?.slackIntegration ?? null;
  const channelId = project.alertConfig?.slackChannelId ?? slack?.channelId ?? null;
  if (!channelId) return { ok: false, reason: "no-channel" };
  if (!slack?.botToken) return { ok: false, reason: "no-bot-token" };

  return { ok: true, target: { channelId, encryptedBotToken: slack.botToken } };
}
