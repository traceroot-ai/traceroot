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
  const lockTails = new Map<string, Promise<void>>();
  const requestedLockKeys: string[] = [];
  let enforceAdvisoryLocks = true;
  let blockedLock:
    | { key: string; entered: () => void; enteredPromise: Promise<void>; release: () => void }
    | undefined;
  let pendingReadBarrier:
    | { workspaceId: string; count: number; promise: Promise<void>; release: () => void }
    | undefined;

  async function acquireLock(key: string): Promise<() => void> {
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    lockTails.set(key, tail);
    await previous;
    return () => {
      release();
      if (lockTails.get(key) === tail) lockTails.delete(key);
    };
  }

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
      const status = where.status as { in?: string[] } | undefined;
      if (
        pendingReadBarrier &&
        where.workspaceId === pendingReadBarrier.workspaceId &&
        status?.in?.includes(statuses.PENDING)
      ) {
        const barrier = pendingReadBarrier;
        barrier.count++;
        if (barrier.count === 2) barrier.release();
        await barrier.promise;
      }
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
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>[];
      take: number;
      select?: Record<string, boolean>;
    }): Promise<Pick<StoredEvent, "id" | "workspaceId" | "meter" | "periodStart">[]> {
      const selected = events.filter((event) => matches(event, where));
      for (const ordering of [...(orderBy ?? [])].reverse()) {
        const [field, rawDirection] = Object.entries(ordering)[0]!;
        const direction =
          typeof rawDirection === "object" && rawDirection !== null
            ? (rawDirection as { sort: "asc" | "desc" }).sort
            : rawDirection;
        selected.sort((a, b) => {
          const first = a[field as keyof StoredEvent];
          const second = b[field as keyof StoredEvent];
          const comparison =
            first === null || second === null
              ? first === second
                ? 0
                : first === null
                  ? (rawDirection as { nulls?: "first" | "last" }).nulls === "first"
                    ? -1
                    : 1
                  : (rawDirection as { nulls?: "first" | "last" }).nulls === "first"
                    ? 1
                    : -1
              : first instanceof Date && second instanceof Date
                ? first.getTime() - second.getTime()
                : String(first).localeCompare(String(second));
          return direction === "asc" ? comparison : -comparison;
        });
      }
      return selected.slice(0, take).map(({ id, workspaceId, meter, periodStart }) => ({
        id,
        workspaceId,
        meter,
        periodStart,
      }));
    },
    async create({ data }: { data: Record<string, unknown> }): Promise<StoredEvent> {
      if (
        events.some(
          (event) =>
            event.workspaceId === data.workspaceId &&
            event.meter === data.meter &&
            event.periodStart.getTime() === (data.periodStart as Date).getTime() &&
            event.cumulativeUnits === data.cumulativeUnits,
        )
      ) {
        throw new Error("unique meter event target constraint");
      }
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
      let release: (() => void) | undefined;
      try {
        return await callback({
          $executeRaw: async (_strings: TemplateStringsArray, lockKey: string) => {
            requestedLockKeys.push(lockKey);
            if (enforceAdvisoryLocks) {
              release = await acquireLock(lockKey);
              if (blockedLock?.key === lockKey) {
                blockedLock.entered();
                await blockedLock.enteredPromise;
              }
            }
            return 1;
          },
          stripeMeterEvent: delegate,
        });
      } finally {
        release?.();
      }
    },
  };

  return {
    events,
    statuses,
    prisma,
    requestedLockKeys,
    blockNextTwoPendingReads(workspaceId: string) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      pendingReadBarrier = { workspaceId, count: 0, promise, release };
    },
    disableAdvisoryLockEnforcement() {
      enforceAdvisoryLocks = false;
    },
    blockTransactionOnLock(key: string) {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      blockedLock = { key, entered, enteredPromise: gate, release };
      return { entered: enteredPromise, release };
    },
    reset() {
      events.length = 0;
      eventSequence = 0;
      lockTails.clear();
      requestedLockKeys.length = 0;
      enforceAdvisoryLocks = true;
      blockedLock = undefined;
      pendingReadBarrier = undefined;
    },
  };
});

vi.mock("@traceroot/core", () => ({
  prisma: mocks.prisma,
  StripeMeterEventStatus: mocks.statuses,
}));

import {
  recoverPendingUsageMeterEvents,
  submitUsageMeterEvent,
  type UsageMeter,
} from "../meterEventOutbox.js";

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
    expect(mocks.requestedLockKeys).toEqual([
      `ws-1:ai_usage:${PERIOD_START.toISOString()}`,
      `ws-1:ai_usage:${PERIOD_START.toISOString()}`,
    ]);
  });

  it("allows different workspace, meter, and period locks to proceed independently", async () => {
    const create = vi.fn().mockResolvedValue({});
    const firstLock = `ws-1:ai_usage:${PERIOD_START.toISOString()}`;
    const blocked = mocks.blockTransactionOnLock(firstLock);
    const first = submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }));
    await blocked.entered;
    let independent: Promise<number | null>[] = [];
    try {
      independent = [
        submitUsageMeterEvent(args({ workspaceId: "ws-2", stripeClient: stripeClient(create) })),
        submitUsageMeterEvent(args({ meter: "rca_usage", stripeClient: stripeClient(create) })),
        submitUsageMeterEvent(
          args({
            periodStart: new Date("2026-12-01T00:00:00.000Z"),
            stripeClient: stripeClient(create),
          }),
        ),
      ];
      expect(mocks.requestedLockKeys).toContain("ws-2:ai_usage:2026-11-01T00:00:00.000Z");
      expect(mocks.requestedLockKeys).toContain("ws-1:rca_usage:2026-11-01T00:00:00.000Z");
      expect(mocks.requestedLockKeys).toContain("ws-1:ai_usage:2026-12-01T00:00:00.000Z");
    } finally {
      blocked.release();
    }
    await Promise.all([first, ...independent]);
  });

  // Disabling the mock's key lock models a removed/nonfunctional production
  // advisory lock; concurrent snapshots then race at the unique constraint.
  it("fails its concurrency negative control when advisory-lock enforcement is removed", async () => {
    mocks.disableAdvisoryLockEnforcement();
    mocks.blockNextTwoPendingReads("ws-1");
    const create = vi.fn().mockResolvedValue({});
    const request = args({ stripeClient: stripeClient(create) });

    const outcomes = await Promise.allSettled([
      submitUsageMeterEvent(request),
      submitUsageMeterEvent(request),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(mocks.events).toHaveLength(1);
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

  it("recovers a previous-period pending event using its original immutable payload", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("worker restart")).mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await submitUsageMeterEvent(
      args({
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        totalUnits: 700,
        customerId: "cus_old",
        stripeClient: stripeClient(create),
      }),
    );
    const pendingEvent = structuredClone(mocks.events[0]!);
    const originalPayload = eventParams(create)[0];
    create.mockClear();
    create.mockResolvedValue({});

    await recoverPendingUsageMeterEvents(stripeClient(create), NOW);

    expect(mocks.events[0]).toMatchObject({
      id: pendingEvent.id,
      identifier: pendingEvent.identifier,
      workspaceId: "ws-1",
      meter: "ai_usage",
      periodStart: new Date("2026-10-01T00:00:00.000Z"),
      cumulativeUnits: 700,
      customerId: "cus_old",
      units: 700,
      eventTimestamp: pendingEvent.eventTimestamp,
      status: "SUBMITTED",
    });
    expect(eventParams(create)[0]).toEqual(originalPayload);
  });

  it("keeps new-period usage isolated from a recovered previous-period event", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("worker restart")).mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await submitUsageMeterEvent(
      args({
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        totalUnits: 700,
        stripeClient: stripeClient(create),
      }),
    );

    await recoverPendingUsageMeterEvents(stripeClient(create), NOW);
    const currentPeriodUnits = await submitUsageMeterEvent(
      args({
        periodStart: new Date("2026-12-01T00:00:00.000Z"),
        totalUnits: 300,
        stripeClient: stripeClient(create),
        now: new Date("2026-12-03T00:00:00.000Z"),
      }),
    );

    expect(currentPeriodUnits).toBe(300);
    expect(mocks.events).toHaveLength(2);
    expect(mocks.events[1]).toMatchObject({
      periodStart: new Date("2026-12-01T00:00:00.000Z"),
      cumulativeUnits: 300,
      units: 300,
    });
  });

  it("returns only recovered cumulative units when the newer delta fails", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker restart"))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("new delta timed out"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = args({ totalUnits: 500, stripeClient: stripeClient(create) });
    expect(await submitUsageMeterEvent(request)).toBeNull();

    await recoverPendingUsageMeterEvents(stripeClient(create), new Date(NOW.getTime() + 60_000));
    const confirmedUnits = await submitUsageMeterEvent(
      args({
        totalUnits: 1_000,
        lastReportedUnits: 0,
        stripeClient: stripeClient(create),
        now: new Date(NOW.getTime() + 120_000),
      }),
    );

    expect(confirmedUnits).toBe(500);
    expect(mocks.events).toHaveLength(2);
    expect(mocks.events[0]!.status).toBe("SUBMITTED");
    expect(mocks.events[1]).toMatchObject({
      cumulativeUnits: 1_000,
      units: 500,
      status: "PENDING",
    });
  });

  it("recovers a pending event with a stale claim after a worker crash", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker interrupted"))
      .mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await submitUsageMeterEvent(args({ stripeClient: stripeClient(create) }));
    const event = mocks.events[0]!;
    const identifier = event.identifier;
    event.claimToken = "crashed-worker";
    event.claimedAt = new Date(NOW.getTime() - 6 * 60 * 1000);
    create.mockClear();
    create.mockResolvedValue({});

    await recoverPendingUsageMeterEvents(stripeClient(create), NOW);

    expect(event.status).toBe("SUBMITTED");
    expect(event.identifier).toBe(identifier);
    expect(event.attemptCount).toBe(2);
    expect(eventParams(create)[0]!.identifier).toBe(identifier);
  });

  it("does not resend a previous-period event requiring reconciliation", async () => {
    const create = vi.fn().mockRejectedValue(new Error("timed out"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await submitUsageMeterEvent(
      args({
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        stripeClient: stripeClient(create),
      }),
    );
    const event = mocks.events[0]!;
    event.ambiguousSince = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    event.status = "RECONCILIATION_REQUIRED";
    create.mockClear();

    await recoverPendingUsageMeterEvents(stripeClient(create), NOW);

    expect(event.status).toBe("RECONCILIATION_REQUIRED");
    expect(create).not.toHaveBeenCalled();
  });
});
