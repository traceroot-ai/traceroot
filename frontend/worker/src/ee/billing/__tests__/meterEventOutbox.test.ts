import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

interface StoredEvent {
  id: string;
  workspaceId: string;
  meter: string;
  periodStart: Date;
  cumulativeUnits: number;
  eventName: string;
  identifier: string;
  customerId: string;
  units: number;
  eventTimestamp: Date;
  status: string;
  attemptCount: number;
  firstAttemptAt: Date | null;
  ambiguousSince: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  claimToken: string | null;
  claimedAt: Date | null;
  submittedAt: Date | null;
  createTime: Date;
  updateTime: Date;
}

const mocks = vi.hoisted(() => {
  const events: StoredEvent[] = [];
  const statuses = {
    PENDING: "PENDING",
    SUBMITTED: "SUBMITTED",
    RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
  };
  let eventSequence = 0;
  let transactionTail = Promise.resolve();

  function matches(event: StoredEvent, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === "OR") {
        return (expected as Record<string, unknown>[]).some((condition) =>
          matches(event, condition),
        );
      }
      if (
        key === "status" &&
        typeof expected === "object" &&
        expected !== null &&
        "in" in expected
      ) {
        return (expected as { in: string[] }).in.includes(event.status);
      }
      if (
        key === "claimedAt" &&
        typeof expected === "object" &&
        expected !== null &&
        "lte" in expected
      ) {
        return event.claimedAt !== null && event.claimedAt <= (expected as { lte: Date }).lte;
      }
      if (key === "firstAttemptAt" && expected === null) return event.firstAttemptAt === null;
      if (key === "periodStart" && expected instanceof Date) {
        return event.periodStart.getTime() === expected.getTime();
      }
      return event[key as keyof StoredEvent] === expected;
    });
  }

  const delegate = {
    async findFirst({
      where,
      orderBy,
    }: {
      where: Record<string, unknown>;
      orderBy?: Record<string, "asc" | "desc">;
    }): Promise<StoredEvent | null> {
      const selected = events.filter((event) => matches(event, where));
      if (orderBy) {
        const [field, direction] = Object.entries(orderBy)[0]!;
        selected.sort((a, b) => {
          const first = a[field as keyof StoredEvent];
          const second = b[field as keyof StoredEvent];
          const comparison =
            first instanceof Date && second instanceof Date
              ? first.getTime() - second.getTime()
              : Number(first) - Number(second);
          return direction === "asc" ? comparison : -comparison;
        });
      }
      return selected[0] ? structuredClone(selected[0]) : null;
    },
    async create({ data }: { data: Record<string, unknown> }): Promise<StoredEvent> {
      const created: StoredEvent = {
        ...(data as Omit<
          StoredEvent,
          | "id"
          | "status"
          | "attemptCount"
          | "firstAttemptAt"
          | "ambiguousSince"
          | "lastAttemptAt"
          | "lastErrorCode"
          | "claimToken"
          | "claimedAt"
          | "submittedAt"
          | "createTime"
          | "updateTime"
        >),
        id: `event-${++eventSequence}`,
        status: statuses.PENDING,
        attemptCount: 0,
        firstAttemptAt: null,
        ambiguousSince: null,
        lastAttemptAt: null,
        lastErrorCode: null,
        claimToken: null,
        claimedAt: null,
        submittedAt: null,
        createTime: new Date("2026-11-15T00:00:00.000Z"),
        updateTime: new Date("2026-11-15T00:00:00.000Z"),
      };
      events.push(created);
      return structuredClone(created);
    },
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }> {
      const event = events.find((candidate) => matches(candidate, where));
      if (!event) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        if (
          key === "attemptCount" &&
          typeof value === "object" &&
          value !== null &&
          "increment" in value
        ) {
          event.attemptCount += (value as { increment: number }).increment;
        } else {
          (event as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return { count: 1 };
    },
    async findUnique({ where }: { where: Record<string, unknown> }): Promise<StoredEvent | null> {
      const event = events.find((candidate) => matches(candidate, where));
      return event ? structuredClone(event) : null;
    },
  };

  const prisma = {
    stripeMeterEvent: delegate,
    async $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback({
          $executeRaw: async () => 1,
          stripeMeterEvent: delegate,
        });
      } finally {
        release();
      }
    },
  };

  return {
    events,
    statuses,
    prisma,
    reset() {
      events.length = 0;
      eventSequence = 0;
      transactionTail = Promise.resolve();
    },
  };
});

vi.mock("@traceroot/core", () => ({
  prisma: mocks.prisma,
  StripeMeterEventStatus: mocks.statuses,
}));

import { submitUsageMeterEvent, type UsageMeter } from "../meterEventOutbox.js";

const PERIOD_START = new Date("2026-11-01T00:00:00.000Z");
const NOW = new Date("2026-11-15T12:34:56.789Z");

function args(overrides: Partial<Parameters<typeof submitUsageMeterEvent>[0]> = {}) {
  return {
    workspaceId: "ws-1",
    customerId: "cus_123",
    meter: "ai_usage" as UsageMeter,
    periodStart: PERIOD_START,
    totalUnits: 1_000,
    lastReportedUnits: 0,
    stripeClient: stripeClient(),
    now: NOW,
    ...overrides,
  };
}

function stripeClient(create: Parameters<typeof vi.fn>[0] = vi.fn().mockResolvedValue({})): Stripe {
  return {
    billing: { meterEvents: { create } },
  } as unknown as Stripe;
}

function eventParams(calls: ReturnType<typeof vi.fn>) {
  return calls.mock.calls.map(([params]) => params);
}

describe("Stripe meter event outbox", () => {
  beforeEach(() => {
    mocks.reset();
    vi.restoreAllMocks();
  });

  it("persists one immutable event before submission and advances the reported checkpoint", async () => {
    const create = vi.fn().mockResolvedValue({});
    const reportedUnits = await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }));

    expect(reportedUnits).toBe(1_000);
    expect(mocks.events).toHaveLength(1);
    expect(mocks.events[0]).toMatchObject({
      workspaceId: "ws-1",
      meter: "ai_usage",
      periodStart: PERIOD_START,
      cumulativeUnits: 1_000,
      eventName: "ai_usage",
      customerId: "cus_123",
      units: 1_000,
      eventTimestamp: new Date("2026-11-15T12:34:56.000Z"),
      status: "SUBMITTED",
    });
    expect(eventParams(create)).toEqual([
      {
        event_name: "ai_usage",
        payload: { stripe_customer_id: "cus_123", value: "1000" },
        timestamp: Math.floor(NOW.getTime() / 1000),
        identifier: mocks.events[0]!.identifier,
      },
    ]);
  });

  it("reuses the exact identifier and payload when Stripe accepted but the response timed out", async () => {
    const acceptedIdentifiers = new Set<string>();
    let acceptedCount = 0;
    const create = vi.fn(
      async (params: Parameters<Stripe["billing"]["meterEvents"]["create"]>[0]) => {
        if (!acceptedIdentifiers.has(params.identifier!)) {
          acceptedIdentifiers.add(params.identifier!);
          acceptedCount++;
        }
        if (create.mock.calls.length === 1) throw new Error("request timed out");
        return {} as Awaited<ReturnType<Stripe["billing"]["meterEvents"]["create"]>>;
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }))).toBeNull();
    const pending = mocks.events[0]!;
    expect(pending.status).toBe("PENDING");
    const firstPayload = eventParams(create)[0];

    expect(
      await submitUsageMeterEvent(
        args({
          stripeClient: stripeClient(create),
          now: new Date(NOW.getTime() + 60_000),
        }),
      ),
    ).toBe(1_000);
    expect(mocks.events).toHaveLength(1);
    expect(mocks.events[0]!.status).toBe("SUBMITTED");
    expect(eventParams(create)[1]).toEqual(firstPayload);
    expect(acceptedCount).toBe(1);
  });

  it("keeps a definite rejection retryable with the original identifier", async () => {
    const definiteRejection = Object.assign(new Error("invalid request"), {
      code: "invalid_request_error",
      statusCode: 400,
    });
    const create = vi.fn().mockRejectedValueOnce(definiteRejection).mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }))).toBeNull();
    const identifier = mocks.events[0]!.identifier;
    expect(mocks.events[0]!.status).toBe("PENDING");

    expect(
      await submitUsageMeterEvent(
        args({
          stripeClient: stripeClient(create),
          now: new Date(NOW.getTime() + 60_000),
        }),
      ),
    ).toBe(1_000);
    expect(mocks.events).toHaveLength(1);
    expect(eventParams(create)[1]!.identifier).toBe(identifier);
  });

  it("continues retrying a definite rejection beyond the identifier deduplication window", async () => {
    const definiteRejection = Object.assign(new Error("invalid request"), {
      statusCode: 400,
    });
    const create = vi.fn().mockRejectedValueOnce(definiteRejection).mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }));
    expect(mocks.events[0]!.ambiguousSince).toBeNull();

    expect(
      await submitUsageMeterEvent(
        args({
          stripeClient: stripeClient(create),
          now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
        }),
      ),
    ).toBe(1_000);
    expect(mocks.events).toHaveLength(1);
    expect(mocks.events[0]!.status).toBe("SUBMITTED");
  });

  it("recovers a persisted pending event on a fresh delivery attempt", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker interrupted"))
      .mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }));
    const identifier = mocks.events[0]!.identifier;
    const recovered = await submitUsageMeterEvent(
      args({
        stripeClient: stripeClient(create),
        now: new Date(NOW.getTime() + 10_000),
      }),
    );

    expect(recovered).toBe(1_000);
    expect(mocks.events).toHaveLength(1);
    expect(mocks.events[0]!.identifier).toBe(identifier);
    expect(mocks.events[0]!.status).toBe("SUBMITTED");
  });

  it("resolves the old pending payload before accounting for newly measured usage", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("timed out")).mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }));
    const original = mocks.events[0]!;
    const firstPayload = eventParams(create)[0];

    expect(
      await submitUsageMeterEvent(
        args({
          totalUnits: 1_500,
          stripeClient: stripeClient(create),
          now: new Date(NOW.getTime() + 60_000),
        }),
      ),
    ).toBe(1_000);
    expect(eventParams(create)[1]).toEqual(firstPayload);
    expect(original.units).toBe(1_000);

    expect(
      await submitUsageMeterEvent(
        args({
          totalUnits: 1_500,
          lastReportedUnits: 1_000,
          stripeClient: stripeClient(create),
          now: new Date(NOW.getTime() + 120_000),
        }),
      ),
    ).toBe(1_500);
    expect(mocks.events).toHaveLength(2);
    expect(mocks.events[1]!.units).toBe(500);
    expect(eventParams(create)[2]!.payload.value).toBe("500");
  });

  it("allows only one concurrent worker to submit the same logical increment", async () => {
    const create = vi.fn().mockResolvedValue({});
    const request = args({ stripeClient: stripeClient(create) });

    const results = await Promise.all([
      submitUsageMeterEvent(request),
      submitUsageMeterEvent(request),
    ]);

    expect(results).toContain(1_000);
    expect(results.every((value) => value === null || value === 1_000)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(mocks.events).toHaveLength(1);
    expect(mocks.events[0]!.status).toBe("SUBMITTED");
  });

  it("moves an old ambiguous event to reconciliation instead of resending it", async () => {
    const create = vi.fn().mockRejectedValue(new Error("timed out"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }));

    const afterWindow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    await expect(
      submitUsageMeterEvent(args({ stripeClient: stripeClient(create), now: afterWindow })),
    ).rejects.toThrow("requires reconciliation");

    expect(mocks.events).toHaveLength(1);
    expect(mocks.events[0]!.status).toBe("RECONCILIATION_REQUIRED");
    expect(mocks.events[0]!.lastErrorCode).toBe("identifier_window_expired");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not expire an ambiguous event while another worker holds its claim", async () => {
    const create = vi.fn().mockRejectedValue(new Error("timed out"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }));

    const afterWindow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    mocks.events[0]!.claimToken = "active-worker";
    mocks.events[0]!.claimedAt = afterWindow;

    expect(
      await submitUsageMeterEvent(args({ stripeClient: stripeClient(create), now: afterWindow })),
    ).toBeNull();
    expect(mocks.events[0]!.status).toBe("PENDING");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("isolates all meters and billing periods and does not resend a successful checkpoint", async () => {
    const create = vi.fn().mockResolvedValue({});
    const meters: UsageMeter[] = ["ai_usage", "rca_usage", "detector_usage"];
    for (const meter of meters) {
      await submitUsageMeterEvent(args({ meter, stripeClient: stripeClient(create) }));
    }

    await submitUsageMeterEvent(
      args({
        meter: "ai_usage",
        periodStart: new Date("2026-12-01T00:00:00.000Z"),
        stripeClient: stripeClient(create),
      }),
    );
    expect(mocks.events).toHaveLength(4);
    expect(new Set(mocks.events.map((event) => event.identifier)).size).toBe(4);
    expect(mocks.events.map((event) => event.eventName)).toEqual([
      "ai_usage",
      "rca_usage",
      "detector_usage",
      "ai_usage",
    ]);
    expect(mocks.events[0]!.periodStart).not.toEqual(mocks.events[3]!.periodStart);

    expect(await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }))).toBe(1_000);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("honors a successful legacy usage checkpoint without creating another event", async () => {
    const create = vi.fn().mockResolvedValue({});

    expect(
      await submitUsageMeterEvent(
        args({
          totalUnits: 1_000,
          lastReportedUnits: 1_000,
          stripeClient: stripeClient(create),
        }),
      ),
    ).toBe(1_000);
    expect(mocks.events).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });
});
