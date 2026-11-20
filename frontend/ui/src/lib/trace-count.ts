/**
 * Each workspace owner's `trace_count`, set once a day on their PostHog person.
 *
 * The count adds up `currentUsage.traces`, which the hourly billing job writes,
 * over the workspaces the person owns: a lifetime total on the free plan and the
 * current billing period's on paid plans. A workspace's owner is its creator, or
 * its earliest admin where `createdBy` is empty; the shared demo workspace is
 * nobody's. Run by the web app's scheduled tick (`POST /api/internal/scheduled-tick`).
 *
 * Overlapping ticks never send a person the count twice in a UTC day. A tick
 * claims the person (`trace_count_claimed_at`) with a conditional write, sends the
 * count and waits for PostHog to accept it, then marks the day done
 * (`trace_count_reported_on`). A claim held by another tick is skipped; one older
 * than the lease belongs to a tick that died, and is taken over. A tick that dies
 * after PostHog accepted the count but before marking the day done has its person
 * sent the same count again by that later tick; setting the property twice is
 * harmless. A send PostHog does not accept gives the claim back and ends the tick,
 * leaving the rest to the next one.
 *
 * A tick sends to at most TRACE_COUNT_BATCH_SIZE people within
 * TRACE_COUNT_TIME_BUDGET_MS, so it answers well inside the caller's timeout; a send
 * still unanswered at the deadline is given back like a failed one. People
 * go in order of their last report, never-reported first, so when there are more
 * owners than a day's ticks can reach, the ones left out today go first tomorrow.
 */
import { prisma, Role } from "@traceroot/core";
import { demoWorkspaceId } from "@/lib/demo-workspace";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { isServerAnalyticsEnabled, sendServerPersonProperties } from "@/lib/posthog-server";
import { utcDay } from "@/lib/utc-day";

/** People sent their count in one tick; the rest wait for the next one, 15 minutes on. */
export const TRACE_COUNT_BATCH_SIZE = 100;

/**
 * How long a tick spends sending. Past it the tick starts no new send, stops waiting
 * for the one in flight (PostHog's own retries can take most of a minute) and leaves
 * the rest to the next tick. Well inside the scheduler's request timeout
 * (WEB_TICK_TIMEOUT_MS, 60s), so the tick answers before the caller gives up on it.
 */
export const TRACE_COUNT_TIME_BUDGET_MS = 40_000;

/** How long a claim protects a send in progress; well past one PostHog request with retries. */
export const TRACE_COUNT_CLAIM_LEASE_MS = 2 * 60 * 1000;

export type TraceCountRun =
  | { kind: "analytics_off" }
  | {
      kind: "sent";
      /** People this tick sent the count to. */
      sent: number;
      /** People still due today, left to the next tick by the batch size, the time budget or a failed send. */
      remaining: number;
    };

export async function reportDailyTraceCounts(
  clock: () => Date = () => new Date(),
): Promise<TraceCountRun> {
  // Nowhere to send the property: claiming people for the day would only write rows.
  if (!isServerAnalyticsEnabled()) return { kind: "analytics_off" };

  const startedAt = clock();
  const today = utcDay(startedAt);
  const counts = await traceCountsByOwner();
  const reported = await prisma.userOnboarding.findMany({
    where: { traceCountReportedOn: { not: null } },
    select: { userId: true, traceCountReportedOn: true },
  });
  const lastReport = new Map(
    reported.map((row) => [row.userId, row.traceCountReportedOn!.getTime()]),
  );
  // 0 for never reported, which sorts before any real day.
  const reportedAt = (userId: string) => lastReport.get(userId) ?? 0;
  // The longest since their last report first; the id keeps ties in a fixed order.
  const due = [...counts]
    .filter(([userId]) => reportedAt(userId) < today.getTime())
    .sort(([a], [b]) => reportedAt(a) - reportedAt(b) || (a < b ? -1 : a > b ? 1 : 0));

  const timeLeft = () => startedAt.getTime() + TRACE_COUNT_TIME_BUDGET_MS - clock().getTime();
  let sent = 0;
  for (const [userId, traceCount] of due.slice(0, TRACE_COUNT_BATCH_SIZE)) {
    if (timeLeft() <= 0) break;
    // Another tick may hold this person, or have finished them since the read above.
    const claimedAt = clock();
    if (!(await claim(userId, today, claimedAt))) continue;
    try {
      await withinMs(sendServerPersonProperties(userId, { trace_count: traceCount }), timeLeft());
    } catch (err) {
      await release(userId, claimedAt);
      console.error("[trace-count] PostHog did not accept a count; ending this tick:", err);
      break;
    }
    await markSent(userId, today, claimedAt);
    sent += 1;
  }
  return { kind: "sent", sent, remaining: due.length - sent };
}

/**
 * The promise's outcome, or a rejection once `ms` have passed. The work itself goes
 * on; a send PostHog accepts after the deadline only sets the same value again.
 */
async function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), Math.max(ms, 0));
  });
  promise.catch(() => {}); // a late failure has nobody waiting for it
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
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
