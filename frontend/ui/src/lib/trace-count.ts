/**
 * Each workspace owner's `trace_count`, set once a day on their PostHog person.
 *
 * The count adds up `currentUsage.traces`, which the hourly billing job writes,
 * over the workspaces the person owns: a lifetime total on the free plan and the
 * current billing period's on paid plans. A workspace's owner is its creator, or
 * its earliest admin where `createdBy` is empty; the shared demo workspace is
 * nobody's. Run by the web app's scheduled tick (`POST /api/internal/scheduled-tick`).
 *
 * A person is sent the count once per UTC day however ticks overlap, retry or die
 * halfway. A tick claims the person (`trace_count_claimed_at`) with a conditional
 * write, sends the count and waits for PostHog to accept it, then marks the day
 * done (`trace_count_reported_on`). A claim held by another tick is skipped; one
 * older than the lease belongs to a tick that died before sending, and is taken
 * over. A send PostHog does not accept gives the claim back and ends the tick,
 * leaving the rest to the next one.
 */
import { prisma, Role } from "@traceroot/core";
import { demoWorkspaceId } from "@/lib/demo-workspace";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { isServerAnalyticsEnabled, sendServerPersonProperties } from "@/lib/posthog-server";
import { utcDay } from "@/lib/utc-day";

/** People sent their count in one tick; the rest wait for the next one, 15 minutes on. */
export const TRACE_COUNT_BATCH_SIZE = 100;

/** How long a claim protects a send in progress; well past one PostHog request with retries. */
export const TRACE_COUNT_CLAIM_LEASE_MS = 2 * 60 * 1000;

export type TraceCountRun =
  | { kind: "analytics_off" }
  | {
      kind: "sent";
      /** People this tick sent the count to. */
      sent: number;
      /** People still due today, left to the next tick by the batch size or a failed send. */
      remaining: number;
    };

export async function reportDailyTraceCounts(now: Date = new Date()): Promise<TraceCountRun> {
  // Nowhere to send the property: claiming people for the day would only write rows.
  if (!isServerAnalyticsEnabled()) return { kind: "analytics_off" };

  const today = utcDay(now);
  const counts = await traceCountsByOwner();
  const doneToday = await prisma.userOnboarding.findMany({
    where: { traceCountReportedOn: today },
    select: { userId: true },
  });
  const done = new Set(doneToday.map((row) => row.userId));
  const due = [...counts].filter(([userId]) => !done.has(userId));

  let sent = 0;
  for (const [userId, traceCount] of due.slice(0, TRACE_COUNT_BATCH_SIZE)) {
    // Another tick may hold this person, or have finished them since the read above.
    if (!(await claim(userId, today, now))) continue;
    try {
      await sendServerPersonProperties(userId, { trace_count: traceCount });
    } catch (err) {
      await release(userId, now);
      console.error("[trace-count] PostHog did not accept a count; ending this tick:", err);
      break;
    }
    await markSent(userId, today, now);
    sent += 1;
  }
  return { kind: "sent", sent, remaining: due.length - sent };
}

/** Each owner's traces summed over their workspaces, for owners whose user still exists. */
async function traceCountsByOwner(): Promise<Map<string, number>> {
  const demoId = demoWorkspaceId();
  const workspaces = await prisma.workspace.findMany({
    where: demoId ? { id: { not: demoId } } : {},
    select: {
      createdBy: true,
      currentUsage: true,
      members: {
        where: { role: Role.ADMIN },
        orderBy: { createTime: "asc" },
        take: 1,
        select: { userId: true },
      },
    },
  });

  const counts = new Map<string, number>();
  for (const workspace of workspaces) {
    const owner = workspace.createdBy ?? workspace.members[0]?.userId;
    if (!owner) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + tracesIn(workspace.currentUsage));
  }

  // createdBy is a bare id with no foreign key, so it can name a deleted user.
  const users = await prisma.user.findMany({
    where: { id: { in: [...counts.keys()] } },
    select: { id: true },
  });
  const existing = new Set(users.map((user) => user.id));
  return new Map([...counts].filter(([userId]) => existing.has(userId)));
}

/** `currentUsage.traces`, or 0 before the billing job has written the workspace's usage. */
function tracesIn(currentUsage: unknown): number {
  const traces = (currentUsage as { traces?: unknown } | null)?.traces;
  return typeof traces === "number" && Number.isFinite(traces) ? traces : 0;
}

/**
 * Claims today's send for the user, unless it is done today or another tick holds
 * a live claim on it; true when this call claimed it. The claim is stamped `now`,
 * which identifies it when the send is marked done or given back.
 */
async function claim(userId: string, today: Date, now: Date): Promise<boolean> {
  const claimable = {
    userId,
    AND: [
      { OR: [{ traceCountReportedOn: null }, { traceCountReportedOn: { lt: today } }] },
      {
        OR: [
          { traceCountClaimedAt: null },
          { traceCountClaimedAt: { lt: new Date(now.getTime() - TRACE_COUNT_CLAIM_LEASE_MS) } },
        ],
      },
    ],
  };
  const claimed = { traceCountClaimedAt: now };

  if ((await prisma.userOnboarding.updateMany({ where: claimable, data: claimed })).count) {
    return true;
  }
  try {
    await prisma.userOnboarding.create({ data: { userId, ...claimed } });
    return true;
  } catch (err) {
    if (!isPrismaKnownError(err, "P2002")) throw err;
  }
  // The row exists: done, held by another tick, or created by one a moment ago.
  const { count } = await prisma.userOnboarding.updateMany({ where: claimable, data: claimed });
  return count === 1;
}

/** Marks today's send done, while this tick's claim still stands. */
async function markSent(userId: string, today: Date, claimedAt: Date): Promise<void> {
  await prisma.userOnboarding.updateMany({
    where: { userId, traceCountClaimedAt: claimedAt },
    data: { traceCountReportedOn: today, traceCountClaimedAt: null },
  });
}

/** Gives this tick's claim back, so the next tick sends the count. */
async function release(userId: string, claimedAt: Date): Promise<void> {
  await prisma.userOnboarding.updateMany({
    where: { userId, traceCountClaimedAt: claimedAt },
    data: { traceCountClaimedAt: null },
  });
}
