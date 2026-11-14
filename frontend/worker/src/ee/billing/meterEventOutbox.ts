import { randomUUID } from "node:crypto";
import { prisma, StripeMeterEventStatus } from "@traceroot/core";
import type Stripe from "stripe";

const STRIPE_IDENTIFIER_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const RECOVERY_BATCH_SIZE = 100;

export type UsageMeter = "ai_usage" | "rca_usage" | "detector_usage";

interface SubmitUsageMeterEventArgs {
  workspaceId: string;
  customerId: string;
  meter: UsageMeter;
  periodStart: Date;
  totalUnits: number;
  lastReportedUnits: number;
  stripeClient: Stripe;
  now: Date;
}

const meterEventNames: Record<UsageMeter, string> = {
  ai_usage: "ai_usage",
  rca_usage: "rca_usage",
  detector_usage: "detector_usage",
};

export class MeterEventReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeterEventReconciliationError";
  }
}

function stripeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code.slice(0, 100);
  }
  return error instanceof Error ? error.name.slice(0, 100) : "unknown";
}

function isDefiniteStripeRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return false;
  const { statusCode } = error;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500;
}

/**
 * Persist and submit one cumulative usage increment. A transaction-scoped lock
 * serializes event creation for a workspace/meter/period; network I/O happens
 * after the lock is released, and the Stripe identifier protects concurrent
 * retries of the same immutable event.
 *
 * Stripe only guarantees identifier uniqueness for at least 24 hours and meter
 * summaries are aggregate/async, not a per-identifier reconciliation source.
 * A flagged event must be checked against Stripe request logs or with Stripe
 * support. If accepted, mark it SUBMITTED; if confirmed absent, clear
 * firstAttemptAt and ambiguousSince and return it to PENDING so the same
 * identifier is retried.
 */
export async function submitUsageMeterEvent({
  workspaceId,
  customerId,
  meter,
  periodStart,
  totalUnits,
  lastReportedUnits,
  stripeClient,
  now,
}: SubmitUsageMeterEventArgs): Promise<number | null> {
  const event = await prisma.$transaction(async (tx) => {
    const lockKey = `${workspaceId}:${meter}:${periodStart.toISOString()}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('stripe_meter_event'), hashtext(${lockKey}))`;

    const existing = await tx.stripeMeterEvent.findFirst({
      where: {
        workspaceId,
        meter,
        periodStart,
        status: {
          in: [StripeMeterEventStatus.PENDING, StripeMeterEventStatus.RECONCILIATION_REQUIRED],
        },
      },
      orderBy: { createTime: "asc" },
    });
    if (existing) return existing;

    const latestSubmitted = await tx.stripeMeterEvent.findFirst({
      where: {
        workspaceId,
        meter,
        periodStart,
        status: StripeMeterEventStatus.SUBMITTED,
      },
      orderBy: { cumulativeUnits: "desc" },
    });
    const reportedUnits = Math.max(lastReportedUnits, latestSubmitted?.cumulativeUnits ?? 0);
    if (totalUnits <= reportedUnits) return null;

    const eventTimestamp = new Date(Math.floor(now.getTime() / 1000) * 1000);
    return tx.stripeMeterEvent.create({
      data: {
        workspaceId,
        meter,
        periodStart,
        cumulativeUnits: totalUnits,
        eventName: meterEventNames[meter],
        identifier: randomUUID(),
        customerId,
        units: totalUnits - reportedUnits,
        eventTimestamp,
      },
    });
  });

  if (!event) {
    const latestSubmitted = await prisma.stripeMeterEvent.findFirst({
      where: {
        workspaceId,
        meter,
        periodStart,
        status: StripeMeterEventStatus.SUBMITTED,
      },
      orderBy: { cumulativeUnits: "desc" },
    });
    return Math.max(lastReportedUnits, latestSubmitted?.cumulativeUnits ?? 0);
  }

  const confirmedUnits = await deliverPendingMeterEvent(event.id, stripeClient, now);
  if (confirmedUnits !== null) return confirmedUnits;

  const latestSubmitted = await prisma.stripeMeterEvent.findFirst({
    where: {
      workspaceId,
      meter,
      periodStart,
      status: StripeMeterEventStatus.SUBMITTED,
    },
    orderBy: { cumulativeUnits: "desc" },
  });
  const previouslyConfirmedUnits = Math.max(
    lastReportedUnits,
    latestSubmitted?.cumulativeUnits ?? 0,
  );
  return previouslyConfirmedUnits > lastReportedUnits ? previouslyConfirmedUnits : null;
}

async function deliverPendingMeterEvent(
  eventId: string,
  stripeClient: Stripe,
  now: Date,
): Promise<number | null> {
  const event = await prisma.stripeMeterEvent.findUnique({ where: { id: eventId } });
  if (!event || event.status === StripeMeterEventStatus.SUBMITTED) {
    return event?.cumulativeUnits ?? null;
  }
  if (event.status === StripeMeterEventStatus.RECONCILIATION_REQUIRED) {
    throw new MeterEventReconciliationError(
      `Stripe meter event ${event.identifier} for ${event.workspaceId}/${event.meter} requires reconciliation`,
    );
  }
  if (
    event.ambiguousSince &&
    now.getTime() - event.ambiguousSince.getTime() >= STRIPE_IDENTIFIER_WINDOW_MS
  ) {
    const expired = await prisma.stripeMeterEvent.updateMany({
      where: {
        id: event.id,
        status: StripeMeterEventStatus.PENDING,
        OR: [
          { claimToken: null },
          { claimedAt: { lte: new Date(now.getTime() - CLAIM_LEASE_MS) } },
        ],
      },
      data: {
        status: StripeMeterEventStatus.RECONCILIATION_REQUIRED,
        claimToken: null,
        claimedAt: null,
        lastErrorCode: "identifier_window_expired",
      },
    });
    if (expired.count === 0) {
      const current = await prisma.stripeMeterEvent.findUnique({
        where: { id: event.id },
      });
      if (current?.status === StripeMeterEventStatus.SUBMITTED) return current.cumulativeUnits;
      if (current?.status === StripeMeterEventStatus.PENDING) return null;
    }
    throw new MeterEventReconciliationError(
      `Stripe meter event ${event.identifier} for ${event.workspaceId}/${event.meter} requires reconciliation after the identifier window`,
    );
  }

  const claimToken = randomUUID();
  const claim = await prisma.stripeMeterEvent.updateMany({
    where: {
      id: event.id,
      status: StripeMeterEventStatus.PENDING,
      OR: [{ claimToken: null }, { claimedAt: { lte: new Date(now.getTime() - CLAIM_LEASE_MS) } }],
    },
    data: {
      claimToken,
      claimedAt: now,
      lastAttemptAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (claim.count === 0) return null;

  await prisma.stripeMeterEvent.updateMany({
    where: {
      id: event.id,
      status: StripeMeterEventStatus.PENDING,
      claimToken,
      firstAttemptAt: null,
    },
    data: { firstAttemptAt: now },
  });
  await prisma.stripeMeterEvent.updateMany({
    where: {
      id: event.id,
      status: StripeMeterEventStatus.PENDING,
      claimToken,
      ambiguousSince: null,
    },
    data: { ambiguousSince: now },
  });

  try {
    await stripeClient.billing.meterEvents.create({
      event_name: event.eventName,
      payload: {
        stripe_customer_id: event.customerId,
        value: String(event.units),
      },
      timestamp: Math.floor(event.eventTimestamp.getTime() / 1000),
      identifier: event.identifier,
    });
  } catch (error) {
    const failureData: {
      claimToken: null;
      claimedAt: null;
      lastErrorCode: string;
      ambiguousSince?: null;
    } = {
      claimToken: null,
      claimedAt: null,
      lastErrorCode: stripeErrorCode(error),
    };
    if (event.ambiguousSince === null && isDefiniteStripeRejection(error)) {
      failureData.ambiguousSince = null;
    }
    await prisma.stripeMeterEvent.updateMany({
      where: {
        id: event.id,
        status: StripeMeterEventStatus.PENDING,
        claimToken,
      },
      data: failureData,
    });
    console.error(
      `[Billing] Stripe meter event failed: workspace=${event.workspaceId}, meter=${event.meter}, period=${event.periodStart.toISOString()}, identifier=${event.identifier}, code=${stripeErrorCode(error)}`,
    );
    return null;
  }

  const submitted = await prisma.stripeMeterEvent.updateMany({
    where: {
      id: event.id,
      status: StripeMeterEventStatus.PENDING,
      claimToken,
    },
    data: {
      status: StripeMeterEventStatus.SUBMITTED,
      submittedAt: now,
      claimToken: null,
      claimedAt: null,
      lastErrorCode: null,
    },
  });
  if (submitted.count === 0) {
    const current = await prisma.stripeMeterEvent.findUnique({
      where: { id: event.id },
    });
    if (current?.status !== StripeMeterEventStatus.SUBMITTED) {
      throw new Error(
        `Stripe meter event ${event.identifier} was accepted but its submission state could not be recorded`,
      );
    }
  }

  return event.cumulativeUnits;
}

/**
 * Retry a bounded batch of pending outbox events before the billing job reads
 * current-period usage. Each delivery uses the event's persisted payload and
 * atomic claim, without touching workspace checkpoints.
 */
export async function recoverPendingUsageMeterEvents(
  stripeClient: Stripe,
  now: Date,
): Promise<void> {
  const pendingEvents = await prisma.stripeMeterEvent.findMany({
    where: {
      status: StripeMeterEventStatus.PENDING,
      OR: [{ claimToken: null }, { claimedAt: { lte: new Date(now.getTime() - CLAIM_LEASE_MS) } }],
    },
    orderBy: [
      { lastAttemptAt: { sort: "asc", nulls: "first" } },
      { createTime: "asc" },
      { id: "asc" },
    ],
    take: RECOVERY_BATCH_SIZE,
    select: { id: true, workspaceId: true, meter: true, periodStart: true },
  });

  for (const event of pendingEvents) {
    try {
      await deliverPendingMeterEvent(event.id, stripeClient, now);
    } catch (error) {
      console.error(
        `[Billing] Pending Stripe meter event recovery failed: workspace=${event.workspaceId}, meter=${event.meter}, period=${event.periodStart.toISOString()}`,
        error,
      );
    }
  }
}
