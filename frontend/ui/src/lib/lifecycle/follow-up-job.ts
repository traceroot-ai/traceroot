/**
 * The follow-up emails' job, run by the scheduled tick (every 15 minutes).
 *
 * Each run reads, for every person who signed up since LIFECYCLE_START_AT, the
 * facts the decision needs (lib/lifecycle/follow-up.ts) as they are now, and
 * sends at most the one email that is due. Nothing is queued ahead, so a person
 * who has just sent a first trace, been paused or unsubscribed gets nothing
 * that no longer applies.
 *
 * Off unless LIFECYCLE_EMAILS_ENABLED is "true". With LIFECYCLE_EMAILS_DRY_RUN
 * "true" it decides but sends nothing, and logs one line per due email with the
 * user id and the email's name only, never an address. Cloud only.
 *
 * Sending goes through sendOnce: one claim per (user, email) in email_sends, so
 * a retried or overlapping tick cannot send an email twice, and an email that
 * fails is released and tried again on a later run while it is still due.
 */
import { prisma } from "@traceroot/core";
import {
  isProductMailConfigured,
  resendConfig,
  sendOnce,
  signUnsubscribeToken,
  unsubscribeHeaders,
  UNSUBSCRIBE_PATH,
  type SendOnceResult,
} from "@traceroot/core/email";
import { env } from "@/env";
import { clientEnv } from "@/env.client";
import { demoWorkspaceId, userMembershipWhere } from "@/lib/demo-workspace";
import { isCloud } from "@/lib/server/cloud";
import { displayFirstName } from "@/lib/email/welcome/render";
import { renderFollowUp } from "@/lib/email/follow-up/render";
import type { FollowUpLinks } from "@/lib/email/follow-up/copy";
import {
  decideFollowUp,
  isInvitedOnly,
  type Campaign,
  type FollowUp,
  type FollowUpFacts,
  type NotDueReason,
} from "./follow-up";

export type FollowUpMode = "off" | "dry_run" | "send";

/** The settings the job reads; the process environment in production. */
export type Settings = Record<string, string | undefined>;

/** How the job runs on this deployment, from its settings. */
export function followUpMode(environment: Settings = process.env): FollowUpMode {
  const on = (name: string) => environment[name]?.trim().toLowerCase() === "true";
  if (on("LIFECYCLE_EMAILS_DRY_RUN")) return "dry_run";
  return on("LIFECYCLE_EMAILS_ENABLED") ? "send" : "off";
}

/** LIFECYCLE_START_AT as a date; unset or unreadable keeps everyone out. */
export function lifecycleStartAt(environment: Settings = process.env): Date | null {
  const raw = environment.LIFECYCLE_START_AT?.trim();
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface FollowUpRun {
  mode: FollowUpMode;
  /** People looked at. */
  considered: number;
  /** Emails due, by email (sent, or in a dry run, would have been). */
  due: Partial<Record<FollowUp, number>>;
  /** Why the rest got nothing. */
  notDue: Partial<Record<NotDueReason, number>>;
  /** Of the due emails, how sending went (not in a dry run). */
  sent: number;
  failed: number;
  skipped: number;
}

/** The facts the decision reads, for one person, as they stand now. */
export async function followUpFacts(
  userId: string,
  now: Date,
  startAt: Date | null,
): Promise<FollowUpFacts | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true },
  });
  if (!user) return null;
  const demoId = demoWorkspaceId();
  const [row, sends, memberships] = await Promise.all([
    prisma.userOnboarding.findUnique({
      where: { userId },
      select: { followUpsPausedAt: true, unsubscribedAt: true },
    }),
    prisma.emailSend.findMany({
      where: { userId },
      select: { campaign: true, sentAt: true, claimedAt: true },
    }),
    // The demo is included so it can be told apart: it never counts as theirs.
    prisma.workspaceMember.findMany({
      where: userMembershipWhere(userId, "include-demo"),
      select: { workspace: { select: { id: true, createdBy: true } } },
    }),
  ]);
  const workspaces = memberships
    .map((m) => m.workspace)
    .map((w) => ({ id: w.id, createdBy: w.createdBy, isDemo: w.id === demoId }));
  const ownIds = workspaces.filter((w) => !w.isDemo).map((w) => w.id);

  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: ownIds }, deleteTime: null },
    select: { id: true, firstTraceReceiveTime: true },
  });
  const firstTraceAt = projects
    .map((p) => p.firstTraceReceiveTime)
    .filter((t): t is Date => !!t)
    .reduce<Date | null>((min, t) => (!min || t < min ? t : min), null);
  const [github, slack, evalRun] = await Promise.all([
    prisma.gitHubInstallation.count({ where: { workspaceId: { in: ownIds } } }),
    prisma.slackIntegration.count({ where: { workspaceId: { in: ownIds } } }),
    prisma.evaluationRun.count({ where: { projectId: { in: projects.map((p) => p.id) } } }),
  ]);

  return {
    now,
    isCloud: isCloud(),
    lifecycleStartAt: startAt,
    signedUpAt: user.createdAt,
    paused: !!row?.followUpsPausedAt,
    unsubscribed: !!row?.unsubscribedAt,
    invitedOnly: isInvitedOnly(userId, workspaces),
    firstTraceAt,
    githubConnected: github > 0,
    slackConnected: slack > 0,
    hasRunEval: evalRun > 0,
    // A claimed follow-up counts from its claim: one in flight is not sent
    // again and holds its place in the frequency limits. The welcome counts
    // only once it was sent: the follow-ups continue it, and a claim whose send
    // never finished (failed, or still under way) is no evidence it arrived.
    sends: sends
      .filter((s) => s.campaign !== "welcome" || s.sentAt !== null)
      .map((s) => ({ campaign: s.campaign as Campaign, at: s.sentAt ?? s.claimedAt })),
  };
}

/**
 * Marks the visits that come from the open-signals line: a fixed value on that
 * one link, naming no one. Not a utm_ parameter, so it leaves acquisition
 * attribution alone; it stays in the address when a signal is opened there, so
 * the Signals page's own page views show both steps.
 */
export const OPEN_SIGNALS_SOURCE_PARAM = "from";
export const OPEN_SIGNALS_SOURCE = "email-open-signals";
/** The Resend tag value on the emails that carry that line, and only those. */
export const OPEN_SIGNALS_VARIANT = "open_signals";

/**
 * The project, among those the person can open (a workspace they are a member
 * of, not the demo, not deleted), with the most open signals, counted as the
 * Signals list counts them: open and not merged into another. Ties go to the
 * oldest project, then the lowest id. Null when no project has any.
 */
export async function openSignalsFor(
  userId: string,
): Promise<{ projectId: string; count: number } | null> {
  const demoId = demoWorkspaceId();
  const projects = await prisma.project.findMany({
    where: {
      deleteTime: null,
      workspace: { members: { some: { userId } }, ...(demoId && { id: { not: demoId } }) },
    },
    orderBy: [{ createTime: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (projects.length === 0) return null;
  const counts = await prisma.signal.groupBy({
    by: ["projectId"],
    where: { projectId: { in: projects.map((p) => p.id) }, status: "open", mergedIntoId: null },
    _count: { _all: true },
  });
  const countOf = new Map(counts.map((c) => [c.projectId, c._count._all]));
  let best: { projectId: string; count: number } | null = null;
  for (const { id } of projects) {
    const count = countOf.get(id) ?? 0;
    if (count > 0 && (!best || count > best.count)) best = { projectId: id, count };
  }
  return best;
}

/** Where one person's email links go. */
async function linksFor(
  userId: string,
  appUrl: string,
  campaign: FollowUp,
): Promise<FollowUpLinks> {
  const demoId = demoWorkspaceId();
  const [ownProject, ownWorkspace, demoProject, openSignals] = await Promise.all([
    prisma.project.findFirst({
      where: {
        deleteTime: null,
        workspace: { members: { some: { userId } }, ...(demoId && { id: { not: demoId } }) },
      },
      orderBy: { createTime: "asc" },
      select: { id: true },
    }),
    prisma.workspace.findFirst({
      where: { createdBy: userId, ...(demoId && { id: { not: demoId } }) },
      orderBy: { createTime: "asc" },
      select: { id: true },
    }),
    demoId
      ? prisma.project.findFirst({
          where: { workspaceId: demoId, deleteTime: null },
          orderBy: { createTime: "asc" },
          select: { id: true },
        })
      : null,
    // Only the Slack and GitHub email carries the open-signals line.
    campaign === "connect_slack_github" ? openSignalsFor(userId) : null,
  ]);
  return {
    // A project with no trace shows the setup instructions on its traces page.
    setupUrl: ownProject ? `${appUrl}/projects/${ownProject.id}/traces` : `${appUrl}/onboarding`,
    demoUrl: demoProject ? `${appUrl}/projects/${demoProject.id}/traces` : appUrl,
    integrationsUrl: ownWorkspace
      ? `${appUrl}/workspaces/${ownWorkspace.id}/settings/integrations`
      : `${appUrl}/workspaces`,
    bookingUrl: clientEnv.NEXT_PUBLIC_FOUNDERS_CAL_URL,
    ...(openSignals && {
      openSignals: {
        count: openSignals.count,
        url: `${appUrl}/projects/${openSignals.projectId}/signals?${OPEN_SIGNALS_SOURCE_PARAM}=${OPEN_SIGNALS_SOURCE}`,
      },
    }),
  };
}

/** Sends one follow-up through sendOnce; a second call for the same email sends nothing. */
export async function sendFollowUp(
  user: { id: string; email: string; name: string | null },
  campaign: FollowUp,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<SendOnceResult> {
  const appUrl = env.NEXT_PUBLIC_APP_URL;
  const links = await linksFor(user.id, appUrl, campaign);
  return sendOnce(
    prisma,
    { userId: user.id, campaign, kind: "product" },
    () => {
      const { replyTo } = resendConfig();
      const unsubscribeUrl = `${appUrl}${UNSUBSCRIBE_PATH}?t=${signUnsubscribeToken(user.email)}`;
      const { subject, text, html } = renderFollowUp({
        campaign,
        firstName: displayFirstName(user.name),
        links,
        unsubscribeUrl,
      });
      return {
        to: user.email,
        subject,
        text,
        html,
        kind: "product",
        replyTo,
        idempotencyKey: `${campaign}/${user.id}`,
        // The variant tag marks exactly the emails that carry the open-signals
        // line, so their sends can be told apart from the same email without it.
        tags: {
          category: "product",
          template: campaign,
          ...(links.openSignals && { variant: OPEN_SIGNALS_VARIANT }),
        },
        headers: unsubscribeHeaders({ url: unsubscribeUrl, mailto: replyTo ?? "" }),
      };
    },
    { fetchImpl: options.fetchImpl },
  );
}

/** One run of the job. */
export async function runFollowUps(
  options: { now?: Date; environment?: Settings; fetchImpl?: typeof fetch } = {},
): Promise<FollowUpRun> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? new Date();
  const mode = followUpMode(environment);
  const run: FollowUpRun = {
    mode,
    considered: 0,
    due: {},
    notDue: {},
    sent: 0,
    failed: 0,
    skipped: 0,
  };
  if (mode === "off" || !isCloud()) return run;
  const startAt = lifecycleStartAt(environment);
  if (!startAt) return run;
  // Sending needs the product-mail settings, read where the sender reads them;
  // a dry run does not.
  if (mode === "send" && !isProductMailConfigured()) {
    console.warn("[follow-ups] product mail is not configured; nothing sent");
    return run;
  }

  const people = await prisma.user.findMany({
    where: { createdAt: { gte: startAt, lte: now } },
    select: { id: true, email: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  for (const person of people) {
    run.considered += 1;
    const facts = await followUpFacts(person.id, now, startAt);
    if (!facts) continue;
    const decision = decideFollowUp(facts);
    if (!decision.send) {
      run.notDue[decision.reason] = (run.notDue[decision.reason] ?? 0) + 1;
      continue;
    }
    run.due[decision.send] = (run.due[decision.send] ?? 0) + 1;
    if (mode === "dry_run") {
      console.log(`[follow-ups] dry run: user ${person.id} is due ${decision.send}`);
      continue;
    }
    const result = await sendFollowUp(person, decision.send, { fetchImpl: options.fetchImpl });
    if (result.status === "sent") run.sent += 1;
    else if (result.status === "failed") run.failed += 1;
    else run.skipped += 1;
  }
  return run;
}
