/**
 * Each workspace owner's `trace_count`, set once a day on their PostHog person.
 *
 * The count adds up `currentUsage.traces`, which the hourly billing job writes,
 * over the workspaces the person owns: a lifetime total on the free plan and the
 * current billing period's on paid plans. A workspace's owner is its creator, or
 * its earliest admin where `createdBy` is empty; the shared demo workspace is
 * nobody's. Run by the web app's scheduled tick (`POST /api/internal/scheduled-tick`).
 *
 * A tick claims each owner (`trace_count_claimed_at`) with a conditional write,
 * sends the count and waits for PostHog to accept it, then marks the day done
 * (`trace_count_reported_on`), so overlapping ticks do not both send to the same
 * person. A claim held by another tick is skipped; one older than the lease is
 * taken over.
 *
 * A send PostHog does not accept leaves the claim in place: the owner stays due,
 * no tick retries them until the lease runs out, and the stale claim records the
 * failed attempt, which puts them behind owners not yet tried. The tick goes on
 * with the next owner, so one owner whose delivery keeps failing does not hold up
 * the rest; TRACE_COUNT_FAILURES_TO_STOP failures in a row mean PostHog itself is
 * failing, and end the tick.
 *
 * The same count can still reach PostHog twice in a day: when a tick dies after
 * PostHog accepted it but before marking the day done, or when PostHog accepts a
 * send whose request the tick gave up on (below). Setting the property again to
 * the same value is harmless.
 *
 * A tick sends to at most TRACE_COUNT_BATCH_SIZE people within
 * TRACE_COUNT_TIME_BUDGET_MS, so it answers well inside the caller's timeout; a send
 * still unanswered at the deadline is cancelled and counts as failed. People go in
 * order of their last report, never-reported first, so when there are more owners
 * than a day's ticks can reach, the ones left out today go first tomorrow.
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

/** Failed sends in a row after which a tick stops: PostHog is failing, not one owner. */
export const TRACE_COUNT_FAILURES_TO_STOP = 3;

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
  const history = await prisma.userOnboarding.findMany({
    where: {
      OR: [{ traceCountReportedOn: { not: null } }, { traceCountClaimedAt: { not: null } }],
    },
    select: { userId: true, traceCountReportedOn: true, traceCountClaimedAt: true },
  });
  const rows = new Map(history.map((row) => [row.userId, row]));
  // 0 for never, which sorts before any real time.
  const reportedAt = (userId: string) => rows.get(userId)?.traceCountReportedOn?.getTime() ?? 0;
  const attemptedAt = (userId: string) => rows.get(userId)?.traceCountClaimedAt?.getTime() ?? 0;
  // The longest since their last report first; among those, owners whose last
  // attempt failed go after the ones not yet tried; the id keeps ties in a fixed order.
  const due = [...counts]
    .filter(([userId]) => reportedAt(userId) < today.getTime())
    .sort(
      ([a], [b]) =>
        reportedAt(a) - reportedAt(b) ||
        attemptedAt(a) - attemptedAt(b) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );

  const timeLeft = () => startedAt.getTime() + TRACE_COUNT_TIME_BUDGET_MS - clock().getTime();
  let sent = 0;
  let failuresInARow = 0;
  for (const [userId, traceCount] of due.slice(0, TRACE_COUNT_BATCH_SIZE)) {
    if (timeLeft() <= 0) break;
    // Another tick may hold this person, or have finished them since the read above.
    const claimedAt = clock();
    if (!(await claim(userId, today, claimedAt))) continue;
    // The claim is a database round trip and can be slow; never start a send the
    // budget no longer covers.
    if (timeLeft() <= 0) {
      await release(userId, claimedAt);
      break;
    }
    try {
      await sendServerPersonProperties(
        userId,
        { trace_count: traceCount },
        { signal: AbortSignal.timeout(timeLeft()) },
      );
    } catch (err) {
      // The claim stays: the owner is retried once it runs out, behind the others.
      failuresInARow += 1;
      console.error("[trace-count] PostHog did not accept an owner's count:", err);
      if (failuresInARow >= TRACE_COUNT_FAILURES_TO_STOP) {
        console.error(`[trace-count] ${failuresInARow} failures in a row; ending this tick`);
        break;
      }
      continue;
    }
    failuresInARow = 0;
    await markSent(userId, today, claimedAt);
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
