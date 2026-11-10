import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const store = vi.hoisted(() => ({
  cursors: [] as any[],
  reports: [] as any[],
  reportCalls: [] as any[],
  failNext: null as any,
}));

vi.mock("@traceroot/core", () => {
  const tx: any = {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    billingMeterCursor: {
      upsert: async ({ where, create }: any) => {
        let cursor = store.cursors.find((row) =>
          row.workspaceId === where.workspaceId_meter_periodStart.workspaceId &&
          row.meter === where.workspaceId_meter_periodStart.meter &&
          row.periodStart.getTime() === where.workspaceId_meter_periodStart.periodStart.getTime(),
        );
        if (!cursor) {
          cursor = { id: `cursor-${store.cursors.length + 1}`, ...create, confirmedUnits: 0 };
          store.cursors.push(cursor);
        }
        return cursor;
      },
      findUniqueOrThrow: async ({ where }: any) => store.cursors.find((row) => row.id === where.id),
      findUnique: async ({ where }: any) => store.cursors.find((row) =>
        row.workspaceId === where.workspaceId_meter_periodStart.workspaceId &&
        row.meter === where.workspaceId_meter_periodStart.meter &&
        row.periodStart.getTime() === where.workspaceId_meter_periodStart.periodStart.getTime(),
      ) ?? null,
      update: async ({ where, data }: any) => {
        const row = store.cursors.find((cursor) => cursor.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    billingMeterReport: {
      findFirst: async ({ where }: any) =>
        store.reports.find((row) => row.cursorId === where.cursorId && where.status.in.includes(row.status)) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: `report-${store.reports.length + 1}`,
          attempts: 0,
          firstAttemptAt: null,
          nextAttemptAt: null,
          leaseExpiresAt: null,
          createTime: new Date(),
          ...data,
        };
        store.reports.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = store.reports.find((report) => report.id === where.id);
        if (data.attempts?.increment) row.attempts += data.attempts.increment;
        Object.assign(row, { ...data, attempts: row.attempts });
        return row;
      },
      findUnique: async ({ where }: any) => store.reports.find((row) => row.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const row = store.reports.find((report) => report.id === where.id && report.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  return { prisma: { ...tx, $transaction: async (callback: (client: any) => Promise<any>) => callback(tx) } };
});

import {
  getRetryDelayMs,
  isDefinitiveStripeError,
  reportMeterUsageToStripe,
} from "../stripeMeterOutbox.js";

function stripeStub() {
  const create = vi.fn(async (params: any) => {
    store.reportCalls.push(params);
    if (store.failNext) {
      const error = store.failNext;
      store.failNext = null;
      throw error;
    }
    return { request: { id: "req_123" } } as any;
  });
  return { client: { billing: { meterEvents: { create } } } as unknown as Stripe, create };
}

const periodStart = new Date("2026-11-01T00:00:00.000Z");
function context(stripeClient: Stripe, totalUnits: number) {
  return {
    workspaceId: "ws-1",
    customerId: "cus_1",
    meter: "ai" as const,
    eventName: "ai_usage" as const,
    periodStart,
    totalUnits,
    stripeClient,
  };
}

beforeEach(() => {
  store.cursors = [];
  store.reports = [];
  store.reportCalls = [];
  store.failNext = null;
});

describe("Stripe meter outbox", () => {
  it("persists a stable immutable payload and reuses it after an ambiguous failure", async () => {
    const { client, create } = stripeStub();
    store.failNext = new Error("socket hang up");

    expect(await reportMeterUsageToStripe(context(client, 1500))).toBe(0);
    expect(store.reports).toHaveLength(1);
    const original = store.reports[0];
    expect(original.status).toBe("retryable");
    const firstCall = create.mock.calls[0][0];

    // Make the retry due, then increase usage. The pending report remains 1500.
    original.nextAttemptAt = new Date(0);
    expect(await reportMeterUsageToStripe(context(client, 1600))).toBe(1500);
    expect(store.reports).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    const secondCall = create.mock.calls[1][0];
    expect(secondCall.identifier).toBe(firstCall.identifier);
    expect(secondCall.timestamp).toBe(firstCall.timestamp);
    expect(secondCall.payload.value).toBe("1500");
    expect(secondCall.payload.stripe_customer_id).toBe("cus_1");
    expect(store.cursors[0].confirmedUnits).toBe(1500);

    // The next run creates only the newly accrued 100 units.
    expect(await reportMeterUsageToStripe(context(client, 1600))).toBe(1600);
    expect(store.reports).toHaveLength(2);
    expect(create.mock.calls[2][0].payload.value).toBe("100");
  });

  it("never advances the cursor when Stripe rejects the request", async () => {
    const { client } = stripeStub();
    store.failNext = Object.assign(new Error("invalid request"), { statusCode: 400 });
    expect(await reportMeterUsageToStripe(context(client, 100))).toBe(0);
    expect(store.cursors[0].confirmedUnits).toBe(0);
    expect(store.reports[0].status).toBe("needs_attention");
  });

  it("moves an ambiguous report to manual review before the Stripe identifier window expires", async () => {
    const { client, create } = stripeStub();
    store.failNext = new Error("connection reset");
    await reportMeterUsageToStripe(context(client, 300));
    const report = store.reports[0];
    report.firstAttemptAt = new Date(Date.now() - 21 * 60 * 60 * 1000);
    report.nextAttemptAt = new Date(0);

    expect(await reportMeterUsageToStripe(context(client, 300))).toBe(0);
    expect(report.status).toBe("needs_attention");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("backs off transient errors and stops retrying before the identifier window expires", async () => {
    const { client } = stripeStub();
    store.failNext = Object.assign(new Error("rate limited"), { statusCode: 429 });
    expect(await reportMeterUsageToStripe(context(client, 250))).toBe(0);
    expect(store.reports[0].status).toBe("retryable");
    expect(store.reports[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(getRetryDelayMs(1)).toBe(60_000);
    expect(getRetryDelayMs(20)).toBe(30 * 60_000);
    expect(isDefinitiveStripeError({ statusCode: 429 })).toBe(false);
    expect(isDefinitiveStripeError({ statusCode: 400 })).toBe(true);
  });
});
