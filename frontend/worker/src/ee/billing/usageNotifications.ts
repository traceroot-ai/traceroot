import {
  prisma,
  isBillingEnabled,
  decideUsageNotification,
  type UsageMeter,
} from "@traceroot/core";
import { sendUsageQuotaEmail } from "../../notifications/email.js";

/**
 * Send free-plan usage-quota emails (80% warning, 100% blocked) for one
 * workspace, at most once per usage window per meter.
 *
 * State lives in workspace_usage_notifications keyed (workspace, meter).
 * Sent-at stamps are written ONLY after a confirmed send, so a transient
 * SMTP failure or momentarily-empty admin list retries on the next hourly
 * run instead of being permanently suppressed.
 */
export async function runUsageQuotaNotifications(args: {
  workspaceId: string;
  workspaceName: string;
  // Usage-window anchor the worker measured against. Free plans measure
  // all-time (epoch), so stamps never re-arm unless window semantics change.
  periodStart: Date;
  now: Date;
  meters: Array<{ meter: UsageMeter; used: number; cap: number }>;
}): Promise<void> {
  if (!isBillingEnabled()) return;
  const { workspaceId, workspaceName, periodStart, now } = args;

  const stateRows = await prisma.workspaceUsageNotification.findMany({
    where: { workspaceId },
  });
  const stateByMeter = new Map(stateRows.map((row) => [row.meter, row]));

  // Admin recipients are fetched once, and only when something will be sent.
  let adminEmails: string[] | null = null;
  const getAdminEmails = async (): Promise<string[]> => {
    if (adminEmails === null) {
      const members = await prisma.workspaceMember.findMany({
        where: { workspaceId, role: "ADMIN" },
        select: { user: { select: { email: true } } },
      });
      adminEmails = members.map((m) => m.user.email).filter(Boolean);
    }
    return adminEmails;
  };

  for (const { meter, used, cap } of args.meters) {
    const row = stateByMeter.get(meter);
    // A row anchored to a different usage window carries stale stamps —
    // treat it as unsent and overwrite its stamps on the next real send.
    const state = row != null && row.periodStart.getTime() === periodStart.getTime() ? row : null;

    const decision = decideUsageNotification({ used, cap, state });
    if (decision.send === "none") continue;

    const sent = await sendUsageQuotaEmail({
      to: await getAdminEmails(),
      kind: decision.send,
      meter,
      workspaceId,
      workspaceName,
      used,
      cap,
    });
    if (!sent) {
      console.warn(
        `[Billing] Usage ${decision.send} email not sent for workspace ${workspaceId} (${meter}); retrying next run`,
      );
      continue;
    }

    const warningSentAt = decision.stampWarning ? now : (state?.warningSentAt ?? null);
    const blockedSentAt = decision.stampBlocked ? now : (state?.blockedSentAt ?? null);
    await prisma.workspaceUsageNotification.upsert({
      where: { workspaceId_meter: { workspaceId, meter } },
      create: { workspaceId, meter, periodStart, warningSentAt, blockedSentAt },
      update: { periodStart, warningSentAt, blockedSentAt, updateTime: now },
    });
    console.log(
      `[Billing] Sent usage ${decision.send} email for workspace ${workspaceId} (${meter}): ${used}/${cap}`,
    );
  }
}
