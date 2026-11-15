import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeMeterEvent {
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

const mocks = vi.hoisted(() => ({
  findManyWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  messageCount: vi.fn(),
  messageAggregate: vi.fn(),
  messageGroupBy: vi.fn(),
  messagesForCost: vi.fn(),
  rcaCount: vi.fn(),
  usageDetails: vi.fn(),
  submitMeterEvent: vi.fn(),
  recoverMeterEvents: vi.fn(),
  meterEvents: [] as FakeMeterEvent[],
  meterEventId: 0,
  stripeMeterEventCreate: vi.fn(),
  statuses: {
    PENDING: "PENDING",
    SUBMITTED: "SUBMITTED",
    RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
  },
  MeterEventReconciliationError: class MeterEventReconciliationError extends Error {},
}));

const meterEventDelegate = vi.hoisted(() => {
  function matches(event: FakeMeterEvent, where: Record<string, unknown>): boolean {
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
      if (key === "periodStart" && expected instanceof Date) {
        return event.periodStart.getTime() === expected.getTime();
      }
      if (
        key === "claimedAt" &&
        typeof expected === "object" &&
        expected !== null &&
        "lte" in expected
      ) {
        return event.claimedAt !== null && event.claimedAt <= (expected as { lte: Date }).lte;
      }
      return event[key as keyof FakeMeterEvent] === expected;
    });
  }

  function sortEvents(
    events: FakeMeterEvent[],
    orderBy?: Record<string, unknown> | Record<string, unknown>[],
  ): FakeMeterEvent[] {
    if (!orderBy) return events;
    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    for (const order of [...orders].reverse()) {
      const [field, rawDirection] = Object.entries(order)[0]!;
      const direction =
        typeof rawDirection === "object" && rawDirection !== null
          ? (rawDirection as { sort: "asc" | "desc" }).sort
          : rawDirection;
      const nulls =
        typeof rawDirection === "object" && rawDirection !== null
          ? (rawDirection as { nulls?: "first" | "last" }).nulls
          : undefined;
      events.sort((left, right) => {
        const first = left[field as keyof FakeMeterEvent];
        const second = right[field as keyof FakeMeterEvent];
        if (first === null || second === null) {
          if (first === second) return 0;
          const nullsFirst = nulls ?? (direction === "desc" ? "first" : "last");
          return first === null
            ? nullsFirst === "first"
              ? -1
              : 1
            : nullsFirst === "first"
              ? 1
              : -1;
        }
        const compare =
          first instanceof Date && second instanceof Date
            ? first.getTime() - second.getTime()
            : typeof first === "number" && typeof second === "number"
              ? first - second
              : String(first).localeCompare(String(second));
        return direction === "desc" ? -compare : compare;
      });
    }
    return events;
  }

  const delegate = {
    async findFirst({
      where,
      orderBy,
    }: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }) {
      const events = sortEvents(
        mocks.meterEvents.filter((event) => matches(event, where)),
        orderBy,
      );
      return structuredClone(events[0] ?? null);
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
    }) {
      return sortEvents(
        mocks.meterEvents.filter((event) => matches(event, where)),
        orderBy,
      )
        .slice(0, take)
        .map(({ id, workspaceId, meter, periodStart }) => ({
          id,
          workspaceId,
          meter,
          periodStart,
        }));
    },
    async findUnique({ where }: { where: Record<string, unknown> }) {
      return structuredClone(mocks.meterEvents.find((event) => matches(event, where)) ?? null);
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const now = new Date();
      const event: FakeMeterEvent = {
        ...(data as Omit<
          FakeMeterEvent,
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
        id: `outbox-${++mocks.meterEventId}`,
        status: mocks.statuses.PENDING,
        attemptCount: 0,
        firstAttemptAt: null,
        ambiguousSince: null,
        lastAttemptAt: null,
        lastErrorCode: null,
        claimToken: null,
        claimedAt: null,
        submittedAt: null,
        createTime: now,
        updateTime: now,
      };
      mocks.meterEvents.push(event);
      return structuredClone(event);
    },
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) {
      const event = mocks.meterEvents.find((candidate) => matches(candidate, where));
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
  };
  return delegate;
});

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findMany: mocks.findManyWorkspaces,
      update: mocks.updateWorkspace,
    },
    detectorRca: { count: mocks.rcaCount },
    aIMessage: {
      count: mocks.messageCount,
      aggregate: mocks.messageAggregate,
      groupBy: mocks.messageGroupBy,
      findMany: mocks.messagesForCost,
    },
    stripeMeterEvent: meterEventDelegate,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: async () => 1,
        stripeMeterEvent: meterEventDelegate,
      }),
  },
  StripeMeterEventStatus: mocks.statuses,
  USAGE_CONFIG: { includedUnits: 50_000 },
  PlanType: {
    FREE: "free",
    STARTER: "starter",
    PRO: "pro",
    ENTERPRISE: "enterprise",
  },
  isAiRunBlocked: () => false,
  isRcaRunBlocked: () => false,
  isDetectorRunBlocked: () => false,
  isIngestionBlocked: () => false,
  DETECTOR_HOSTED_LLM_FREE_THRESHOLD: 100,
  AI_RUN_QUOTAS: { pro: { included: 100 } },
  RCA_RUN_QUOTAS: { pro: { included: 100 } },
  DETECTOR_RUN_QUOTAS: { pro: { included: 100 } },
  EVENT_QUOTAS: { pro: { included: 150_000 } },
  findPlanItem: () => ({ id: "si_123", quantity: 3 }),
}));

vi.mock("../clickhouse.js", () => ({
  getWorkspaceUsageDetails: mocks.usageDetails,
}));
vi.mock("../usageNotifications.js", () => ({
  runUsageQuotaNotifications: vi.fn(),
}));
vi.mock("../meterEventOutbox.js", () => ({
  submitUsageMeterEvent: mocks.submitMeterEvent,
  recoverPendingUsageMeterEvents: mocks.recoverMeterEvents,
  MeterEventReconciliationError: mocks.MeterEventReconciliationError,
}));
vi.mock("stripe", () => ({
  default: class StripeMock {
    subscriptions = {
      retrieve: vi.fn().mockResolvedValue({ items: { data: [] } }),
    };
    subscriptionItems = { update: vi.fn() };
    billing = { meterEvents: { create: mocks.stripeMeterEventCreate } };
  },
}));

import { runBillingJob } from "../usageMetering.js";

interface MeterCheckpoint {
  lastReportedUnits?: number;
  lastReportedPeriodStart?: string | null;
}

interface UsageSnapshot {
  ai?: MeterCheckpoint;
  rca?: MeterCheckpoint;
  detector?: MeterCheckpoint;
  [key: string]: unknown;
}

function makeWorkspace() {
  return {
    id: "ws-1",
    name: "Acme",
    billingPlan: "pro",
    billingCustomerId: "cus_123",
    billingSubscriptionId: "sub_123",
    billingPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    billingPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
    ingestionBlocked: false,
    aiBlocked: false,
    rcaBlocked: false,
    detectorBlocked: false,
    currentUsage: {} as UsageSnapshot,
    projects: [{ id: "project-1", deleteTime: null, freeQuotaEligible: true }],
  };
}

let workspace: ReturnType<typeof makeWorkspace>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_mock");
  mocks.meterEvents.length = 0;
  mocks.meterEventId = 0;
  workspace = makeWorkspace();
  mocks.findManyWorkspaces.mockImplementation(async () => [structuredClone(workspace)]);
  mocks.updateWorkspace.mockImplementation(async ({ data }) => {
    workspace = { ...workspace, ...data };
  });
  mocks.messageCount.mockImplementation(async ({ where }: { where: { kind: string } }) =>
    where.kind === "chat" ? 101 : 0,
  );
  mocks.messageAggregate.mockResolvedValue({
    _count: { id: 0 },
    _sum: { inputTokens: 0, outputTokens: 0, cost: 0 },
  });
  mocks.messageGroupBy.mockResolvedValue([]);
  mocks.messagesForCost.mockResolvedValue([]);
  mocks.rcaCount.mockResolvedValue(0);
  mocks.usageDetails.mockResolvedValue({
    traces: 0,
    spans: 0,
    detectorRuns: 0,
    bySource: {
      user: { traces: 0, spans: 0 },
      detector: { traces: 0, spans: 0 },
      agent: { traces: 0, spans: 0 },
    },
  });
  mocks.stripeMeterEventCreate.mockResolvedValue({});
  mocks.submitMeterEvent.mockResolvedValue(1_000);
  mocks.recoverMeterEvents.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkpoint test outbox ordering", () => {
  it("models nested NULL ordering and numeric cumulative-unit ordering", async () => {
    const periodStart = new Date("2026-11-01T00:00:00.000Z");
    const makeEvent = (
      id: string,
      status: string,
      cumulativeUnits: number,
      lastAttemptAt: Date | null,
    ): FakeMeterEvent => ({
      id,
      workspaceId: "ws-1",
      meter: "ai_usage",
      periodStart,
      cumulativeUnits,
      eventName: "ai_usage",
      identifier: id,
      customerId: "cus_123",
      units: cumulativeUnits,
      eventTimestamp: periodStart,
      status,
      attemptCount: lastAttemptAt ? 1 : 0,
      firstAttemptAt: lastAttemptAt,
      ambiguousSince: null,
      lastAttemptAt,
      lastErrorCode: null,
      claimToken: null,
      claimedAt: null,
      submittedAt: null,
      createTime: periodStart,
      updateTime: periodStart,
    });

    mocks.meterEvents.push(
      makeEvent("attempted", "PENDING", 900, new Date("2026-11-02T00:00:00.000Z")),
      makeEvent("never-attempted", "PENDING", 1_000, null),
      makeEvent("submitted-900", "SUBMITTED", 900, null),
      makeEvent("submitted-1000", "SUBMITTED", 1_000, null),
    );

    const pending = await meterEventDelegate.findMany({
      where: {
        status: "PENDING",
        OR: [{ claimToken: null }, { claimedAt: { lte: new Date("2026-11-03T00:00:00.000Z") } }],
      },
      orderBy: [
        { lastAttemptAt: { sort: "asc", nulls: "first" } },
        { createTime: "asc" },
        { id: "asc" },
      ],
      take: 10,
    });
    const latestSubmitted = await meterEventDelegate.findFirst({
      where: { status: "SUBMITTED" },
      orderBy: { cumulativeUnits: "desc" },
    });

    expect(pending.map(({ id }) => id)).toEqual(["never-attempted", "attempted"]);
    expect(latestSubmitted?.cumulativeUnits).toBe(1_000);
  });
});

describe("billing checkpoint updates after outbox submission", () => {
  it("stores only the 500 units confirmed when total usage is 1,000", async () => {
    const operationOrder: string[] = [];
    mocks.recoverMeterEvents.mockImplementation(async () => {
      operationOrder.push("recover");
    });
    mocks.submitMeterEvent.mockImplementation(async () => {
      operationOrder.push("submit");
      return 500;
    });

    await runBillingJob();

    expect(mocks.submitMeterEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        meter: "ai_usage",
        totalUnits: 1_000,
        lastReportedUnits: 0,
      }),
    );
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 500,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
    expect(workspace.currentUsage.ai?.lastReportedUnits).not.toBe(1_000);
    expect(operationOrder).toEqual(["recover", "submit"]);
  });

  it("preserves the prior checkpoint when delivery returns null", async () => {
    workspace.currentUsage = {
      ai: {
        lastReportedUnits: 250,
        lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
      },
    };
    mocks.submitMeterEvent.mockResolvedValue(null);

    await runBillingJob();
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 250,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
  });

  it("recovers the same pending event on the next billing-job run", async () => {
    const { recoverPendingUsageMeterEvents, submitUsageMeterEvent } =
      await vi.importActual<typeof import("../meterEventOutbox.js")>("../meterEventOutbox.js");
    mocks.recoverMeterEvents.mockImplementation(recoverPendingUsageMeterEvents);
    mocks.submitMeterEvent.mockImplementation(submitUsageMeterEvent);
    workspace.currentUsage = {
      ai: {
        lastReportedUnits: 250,
        lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
      },
    };
    mocks.stripeMeterEventCreate
      .mockRejectedValueOnce(new Error("request timed out"))
      .mockResolvedValueOnce({});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBillingJob();

    expect(workspace.currentUsage.ai).toMatchObject({ lastReportedUnits: 250 });
    expect(mocks.meterEvents).toHaveLength(1);
    const [persistedEvent] = mocks.meterEvents;
    expect(persistedEvent).toMatchObject({
      workspaceId: "ws-1",
      meter: "ai_usage",
      cumulativeUnits: 1_000,
      eventName: "ai_usage",
      customerId: "cus_123",
      units: 750,
      status: "PENDING",
    });
    const firstRequest = mocks.stripeMeterEventCreate.mock.calls[0][0];
    expect(firstRequest).toMatchObject({
      event_name: "ai_usage",
      payload: { stripe_customer_id: "cus_123", value: "750" },
      identifier: persistedEvent.identifier,
      timestamp: Math.floor(persistedEvent.eventTimestamp.getTime() / 1000),
    });

    await runBillingJob();

    expect(mocks.recoverMeterEvents).toHaveBeenCalledTimes(2);
    expect(mocks.stripeMeterEventCreate).toHaveBeenCalledTimes(2);
    expect(mocks.meterEvents).toHaveLength(1);
    expect(mocks.meterEvents[0]).toMatchObject({
      id: persistedEvent.id,
      identifier: persistedEvent.identifier,
      eventTimestamp: persistedEvent.eventTimestamp,
      status: "SUBMITTED",
    });
    expect(mocks.stripeMeterEventCreate.mock.calls[1][0]).toEqual(firstRequest);
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 1_000,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
  });

  it("persists the workspace and preserves the checkpoint when submission throws", async () => {
    workspace.currentUsage = {
      ai: {
        lastReportedUnits: 250,
        lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
      },
    };
    workspace.ingestionBlocked = true;
    workspace.aiBlocked = true;
    mocks.submitMeterEvent.mockRejectedValue(new Error("database unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await runBillingJob();
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 250,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
    expect(mocks.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.updateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentUsage: expect.any(Object), aiBlocked: false }),
      }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("workspace=ws-1, meter=ai_usage, period="),
      expect.any(Error),
    );
    expect(errorLog).toHaveBeenCalledWith(
      "[Billing] Error processing workspace ws-1:",
      expect.any(AggregateError),
    );
  });

  it("isolates an expected reconciliation failure and continues another meter", async () => {
    workspace.currentUsage = {
      ai: { lastReportedUnits: 250, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
    };
    mocks.rcaCount.mockResolvedValue(101);
    mocks.submitMeterEvent.mockImplementation(async ({ meter }: { meter: string }) => {
      if (meter === "ai_usage") {
        throw new mocks.MeterEventReconciliationError("manual reconciliation required");
      }
      return 500;
    });
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runBillingJob();

    expect(mocks.submitMeterEvent).toHaveBeenCalledTimes(2);
    expect(workspace.currentUsage.ai).toMatchObject({ lastReportedUnits: 250 });
    expect(workspace.currentUsage.rca).toMatchObject({ lastReportedUnits: 500 });
    expect(mocks.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining("workspace=ws-1, meter=ai_usage, period="),
      expect.any(mocks.MeterEventReconciliationError),
    );
  });

  it("isolates an RCA exception while AI and detector checkpoints advance", async () => {
    workspace.currentUsage = {
      ai: { lastReportedUnits: 200, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
      rca: { lastReportedUnits: 300, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
      detector: { lastReportedUnits: 4, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
    };
    mocks.rcaCount.mockResolvedValue(101);
    mocks.usageDetails.mockResolvedValue({
      traces: 0,
      spans: 0,
      detectorRuns: 200,
      bySource: {
        user: { traces: 0, spans: 0 },
        detector: { traces: 0, spans: 0 },
        agent: { traces: 0, spans: 0 },
      },
    });
    mocks.messageAggregate.mockImplementation(
      async ({ where }: { where: { kind: string; isByok: boolean } }) => ({
        _count: { id: 0 },
        _sum: {
          inputTokens: 0,
          outputTokens: 0,
          cost: where.kind === "detector" && !where.isByok ? 0.2 : 0,
        },
      }),
    );
    mocks.submitMeterEvent.mockImplementation(async ({ meter }: { meter: string }) => {
      if (meter === "rca_usage") throw new Error("RCA outbox unavailable");
      return meter === "ai_usage" ? 500 : 11;
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await runBillingJob();

    expect(mocks.submitMeterEvent).toHaveBeenCalledTimes(3);
    expect(workspace.currentUsage.ai).toMatchObject({ lastReportedUnits: 500 });
    expect(workspace.currentUsage.rca).toMatchObject({ lastReportedUnits: 300 });
    expect(workspace.currentUsage.detector).toMatchObject({ lastReportedUnits: 11 });
    expect(mocks.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("workspace=ws-1, meter=rca_usage, period="),
      expect.any(Error),
    );
  });
});
