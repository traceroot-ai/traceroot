import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { prisma } from "@traceroot/core";

export type BillingMeterName = "ai" | "rca" | "detector";

const RETRY_WINDOW_MS = 20 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const INITIAL_RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 30 * 60 * 1000;

export function getRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 20));
  return Math.min(INITIAL_RETRY_MS * 2 ** exponent, MAX_RETRY_MS);
}

export function isDefinitiveStripeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { statusCode?: number; status?: number; raw?: { statusCode?: number } };
  const status = value.statusCode ?? value.raw?.statusCode ?? value.status;
  return typeof status === "number" && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

export function getRetryAfterMs(error: unknown, now = new Date()): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    headers?: Record<string, string | undefined>;
    raw?: { headers?: Record<string, string | undefined> };
  };
  const header = value.headers?.["retry-after"] ?? value.raw?.headers?.["retry-after"];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : null;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}

type MeterReport = {
  id: string;
  cursorId: string;
  fromUnits: bigint;
  toUnits: bigint;
  units: bigint;
  stripeCustomerId: string;
  eventName: string;
  identifier: string;
  eventTimestamp: number;
  attempts: number;
  firstAttemptAt: Date;
  attemptToken: string;
};

type MeterContext = {
  workspaceId: string;
  customerId: string;
  meter: BillingMeterName;
  eventName: "ai_usage" | "rca_usage" | "detector_usage";
  periodStart: Date;
  totalUnits: number;
  stripeClient: Stripe;
};

async function claimReport(context: MeterContext, now: Date): Promise<MeterReport | null> {
  return prisma.$transaction(async (tx) => {
    const periodStart = context.periodStart;
    const cursor = await tx.billingMeterCursor.upsert({
      where: {
        workspaceId_meter_periodStart: {
          workspaceId: context.workspaceId,
          meter: context.meter,
          periodStart,
        },
      },
      create: {
        workspaceId: context.workspaceId,
        meter: context.meter,
        periodStart,
        confirmedUnits: 0,
      },
      update: {},
    });

    // Serialize report reservation per workspace/meter/period across worker replicas.
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "billing_meter_cursors" WHERE "id" = $1 FOR UPDATE',
      cursor.id,
    );
    const lockedCursor = await tx.billingMeterCursor.findUniqueOrThrow({
      where: { id: cursor.id },
    });
    const unresolved = await tx.billingMeterReport.findFirst({
      where: {
        cursorId: cursor.id,
        status: { in: ["pending", "sending", "retryable", "needs_attention"] },
      },
      orderBy: { createTime: "asc" },
    });

    let report = unresolved;
    if (report?.status === "needs_attention") {
      return null;
    }

    if (!report) {
      if (!Number.isSafeInteger(context.totalUnits) || context.totalUnits < 0) {
        throw new Error(`Invalid billable units: ${context.totalUnits}`);
      }
      const totalUnits = BigInt(context.totalUnits);
      if (totalUnits <= lockedCursor.confirmedUnits) return null;

      const units = totalUnits - lockedCursor.confirmedUnits;
      report = await tx.billingMeterReport.create({
        data: {
          cursorId: cursor.id,
          fromUnits: lockedCursor.confirmedUnits,
          toUnits: totalUnits,
          units,
          stripeCustomerId: context.customerId,
          eventName: context.eventName,
          identifier: `tr_meter_${randomUUID()}`,
          eventTimestamp: Math.floor(now.getTime() / 1000),
          status: "pending",
        },
      });
    }

    if (
      report.status === "sending" &&
      report.leaseExpiresAt &&
      report.leaseExpiresAt.getTime() > now.getTime()
    ) {
      return null;
    }
    if (report.nextAttemptAt && report.nextAttemptAt.getTime() > now.getTime()) {
      return null;
    }

    const firstAttemptAt = report.firstAttemptAt ?? now;
    if (now.getTime() - firstAttemptAt.getTime() >= RETRY_WINDOW_MS) {
      await tx.billingMeterReport.update({
        where: { id: report.id },
        data: {
          status: "needs_attention",
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastError: "Automatic retry stopped before Stripe's meter-event identifier deduplication window expires. Reconcile manually.",
        },
      });
      console.error(
        `[Billing] Meter report ${report.identifier} for workspace ${context.workspaceId} needs manual reconciliation; automatic retries stopped before the 24-hour identifier window.`,
      );
      return null;
    }

    const attemptToken = randomUUID();
    const claimed = await tx.billingMeterReport.update({
      where: { id: report.id },
      data: {
        status: "sending",
        attempts: { increment: 1 },
        firstAttemptAt,
        attemptToken,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        nextAttemptAt: null,
      },
    });

    return {
      id: claimed.id,
      cursorId: claimed.cursorId,
      fromUnits: claimed.fromUnits,
      toUnits: claimed.toUnits,
      units: claimed.units,
      stripeCustomerId: claimed.stripeCustomerId,
      eventName: claimed.eventName,
      identifier: claimed.identifier,
      eventTimestamp: claimed.eventTimestamp,
      attempts: claimed.attempts,
      firstAttemptAt,
      attemptToken,
    };
  });
}

async function markDelivered(report: MeterReport, stripeRequestId?: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "billing_meter_cursors" WHERE "id" = $1 FOR UPDATE',
      report.cursorId,
    );
    const currentReport = await tx.billingMeterReport.findUnique({
      where: { id: report.id },
    });
    if (
      !currentReport ||
      currentReport.status !== "sending" ||
      currentReport.attemptToken !== report.attemptToken
    ) {
      return;
    }

    const cursor = await tx.billingMeterCursor.findUniqueOrThrow({
      where: { id: report.cursorId },
    });
    if (cursor.confirmedUnits !== report.fromUnits) {
      await tx.billingMeterReport.update({
        where: { id: report.id },
        data: {
          status: "needs_attention",
          leaseExpiresAt: null,
          lastError: `Cursor advanced unexpectedly: expected ${report.fromUnits}, found ${cursor.confirmedUnits}.`,
        },
      });
      return;
    }

    await tx.billingMeterCursor.update({
      where: { id: report.cursorId },
      data: { confirmedUnits: report.toUnits },
    });
    await tx.billingMeterReport.update({
      where: { id: report.id },
      data: {
        status: "delivered",
        deliveredAt: new Date(),
        leaseExpiresAt: null,
        nextAttemptAt: null,
        stripeRequestId: stripeRequestId ?? null,
        lastError: null,
      },
    });
  });
}

async function markFailed(report: MeterReport, error: unknown, now: Date): Promise<void> {
  const expired = now.getTime() - report.firstAttemptAt.getTime() >= RETRY_WINDOW_MS;
  const definitive = isDefinitiveStripeError(error);
  const needsAttention = expired || definitive;
  await prisma.billingMeterReport.updateMany({
    where: { id: report.id, status: "sending", attemptToken: report.attemptToken },
    data: {
      status: needsAttention ? "needs_attention" : "retryable",
      leaseExpiresAt: null,
      nextAttemptAt: needsAttention
        ? null
        : new Date(now.getTime() + (getRetryAfterMs(error, now) ?? getRetryDelayMs(report.attempts))),
      lastError: errorMessage(error),
    },
  });
}

/**
 * Reserve, dispatch, and confirm one immutable usage report.
 *
 * There is deliberately at most one unresolved report per cursor. If usage
 * increases while that report is pending, the next delta is not reserved until
 * the prior report is confirmed. An ambiguous failure retries exactly the same
 * identifier, timestamp, customer and unit payload.
 */
export async function reportMeterUsageToStripe(context: MeterContext): Promise<number> {
  const now = new Date();
  const report = await claimReport(context, now);
  if (report) {
    try {
      const response = await context.stripeClient.billing.meterEvents.create({
        event_name: report.eventName,
        payload: {
          stripe_customer_id: report.stripeCustomerId,
          value: String(report.units),
        },
        timestamp: report.eventTimestamp,
        identifier: report.identifier,
      });
      await markDelivered(report, (response as any).lastResponse?.requestId ?? null);
    } catch (error) {
      await markFailed(report, error, new Date());
      console.error(
        `[Billing] Stripe meter report ${report.identifier} for ${context.workspaceId} failed:`,
        error,
      );
    }
  }

  const periodStart = context.periodStart;
  const cursor = await prisma.billingMeterCursor.findUnique({
    where: {
      workspaceId_meter_periodStart: {
        workspaceId: context.workspaceId,
        meter: context.meter,
        periodStart,
      },
    },
    select: { confirmedUnits: true },
  });
  const confirmedUnits = cursor?.confirmedUnits ?? 0n;
  const numericConfirmedUnits = Number(confirmedUnits);
  if (!Number.isSafeInteger(numericConfirmedUnits)) {
    throw new Error(`Confirmed meter units exceed JavaScript's safe integer range: ${confirmedUnits}`);
  }
  return numericConfirmedUnits;
}
