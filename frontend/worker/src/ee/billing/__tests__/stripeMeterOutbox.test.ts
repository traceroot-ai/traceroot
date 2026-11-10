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
        let cursor = store.cursors.find(
          (row) =>
            row.workspaceId === where.workspaceId_meter_periodStart.workspaceId &&
            row.meter === where.workspaceId_meter_periodStart.meter &&
            row.periodStart.getTime() === where.workspaceId_meter_periodStart.periodStart.getTime(),
        );
        if (!cursor) {
          cursor = { id: `cursor-${store.cursors.length + 1}`, ...create, confirmedUnits: 0n };
          store.cursors.push(cursor);
        }
        return cursor;
      },
      findUniqueOrThrow: async ({ where }: any) => store.cursors.find((row) => row.id === where.id),
      findUnique: async ({ where }: any) =>
        store.cursors.find(
          (row) =>
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
        store.reports.find(
          (row) => row.cursorId === where.cursorId && where.status.in.includes(row.status),
        ) ?? null,
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
      findUnique: async ({ where }: any) =>
        store.reports.find((row) => row.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const row = store.reports.find(
          (report) =>
            report.id === where.id &&
            report.status === where.status &&
            (where.attemptToken === undefined || report.attemptToken === where.attemptToken),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: async (callback: (client: any) => Promise<any>) => callback(tx),
    },
  };
});

import {
  getRetryAfterMs,
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
    return { lastResponse: { requestId: "req_123" } } as any;
  });
  return { client: { billing: { meterEvents: { create } } } as unknown as Stripe, create };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
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
    expect(store.cursors[0].confirmedUnits).toBe(1500n);
    expect(store.reports[0].stripeRequestId).toBe("req_123");

    // The next run creates only the newly accrued 100 units.
    expect(await reportMeterUsageToStripe(context(client, 1600))).toBe(1600);
    expect(store.reports).toHaveLength(2);
    expect(create.mock.calls[2][0].payload.value).toBe("100");
  });

  it("does not dispatch a report while another worker holds its unexpired lease", async () => {
    const { client, create } = stripeStub();
    store.cursors.push({
      id: "cursor-1",
      workspaceId: "ws-1",
      meter: "ai",
      periodStart,
      confirmedUnits: 0n,
    });
    store.reports.push({
      id: "report-in-flight",
      cursorId: "cursor-1",
      status: "sending",
      attempts: 1,
      fromUnits: 0n,
      toUnits: 200n,
      units: 200n,
      stripeCustomerId: "cus_1",
      eventName: "ai_usage",
      identifier: "tr_meter_existing",
      attemptToken: "lease-1",
      eventTimestamp: Math.floor(Date.now() / 1000),
      firstAttemptAt: new Date(),
      nextAttemptAt: null,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      createTime: new Date(),
    });

    expect(await reportMeterUsageToStripe(context(client, 250))).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(store.reports).toHaveLength(1);
  });

  it("never advances the cursor when Stripe rejects the request", async () => {
    const { client, create } = stripeStub();
    store.failNext = Object.assign(new Error("invalid request"), { statusCode: 400 });
    expect(await reportMeterUsageToStripe(context(client, 100))).toBe(0);
    expect(store.cursors[0].confirmedUnits).toBe(0n);
    expect(store.reports[0].status).toBe("needs_attention");

    // Manual reconciliation is required before this cursor can send another report.
    expect(await reportMeterUsageToStripe(context(client, 200))).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.reports).toHaveLength(1);
  });

  it("uses the RCA meter event name and skips zero-unit reports", async () => {
    const { client, create } = stripeStub();

    expect(
      await reportMeterUsageToStripe({
        ...context(client, 0),
        meter: "rca",
        eventName: "rca_usage",
      }),
    ).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(store.reports).toHaveLength(0);

    expect(
      await reportMeterUsageToStripe({
        ...context(client, 1500),
        meter: "rca",
        eventName: "rca_usage",
      }),
    ).toBe(1500);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].event_name).toBe("rca_usage");
    expect(create.mock.calls[0][0].payload.value).toBe("1500");
  });

  it("persists totals above PostgreSQL INTEGER range using BIGINT", async () => {
    const { client, create } = stripeStub();

    expect(await reportMeterUsageToStripe(context(client, 3_000_000_000))).toBe(3_000_000_000);
    expect(store.cursors[0].confirmedUnits).toBe(3_000_000_000n);
    expect(store.reports[0].toUnits).toBe(3_000_000_000n);
    expect(create.mock.calls[0][0].payload.value).toBe("3000000000");
  });

  it("ignores a stale failure after another worker reclaims the expired lease", async () => {
    const firstAttempt = createDeferred<any>();
    const secondAttempt = createDeferred<any>();
    const create = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => secondAttempt.promise);
    const client = {
      billing: { meterEvents: { create } },
    } as unknown as Stripe;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    try {
      const firstRun = reportMeterUsageToStripe(context(client, 200));
      await flushMicrotasks();
      expect(create).toHaveBeenCalledTimes(1);
      const firstToken = store.reports[0].attemptToken;

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      const secondRun = reportMeterUsageToStripe(context(client, 200));
      await flushMicrotasks();
      expect(create).toHaveBeenCalledTimes(2);
      const secondToken = store.reports[0].attemptToken;
      expect(secondToken).not.toBe(firstToken);

      firstAttempt.reject(new Error("late timeout from first worker"));
      await firstRun;
      expect(store.reports[0].status).toBe("sending");
      expect(store.reports[0].attemptToken).toBe(secondToken);

      secondAttempt.resolve({ lastResponse: { requestId: "req_second" } });
      await secondRun;
      expect(store.reports[0].status).toBe("delivered");
      expect(store.cursors[0].confirmedUnits).toBe(200n);
    } finally {
      vi.useRealTimers();
    }
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
    store.failNext = Object.assign(new Error("rate limited"), {
      statusCode: 429,
      raw: { headers: { "retry-after": "120" } },
    });
    expect(await reportMeterUsageToStripe(context(client, 250))).toBe(0);
    expect(store.reports[0].status).toBe("retryable");
    expect(store.reports[0].nextAttemptAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 119_000);
    expect(getRetryAfterMs({ raw: { headers: { "retry-after": "120" } } })).toBe(120_000);
    expect(getRetryDelayMs(1)).toBe(60_000);
    expect(getRetryDelayMs(20)).toBe(30 * 60_000);
    expect(isDefinitiveStripeError({ statusCode: 429 })).toBe(false);
    expect(isDefinitiveStripeError({ statusCode: 400 })).toBe(true);
  });
});
