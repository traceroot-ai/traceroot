import { describe, it, expect, vi, beforeEach } from "vitest";

// Chat runs persist as MULTIPLE assistant rows per run (one text segment per
// tool boundary); only the final segment carries usage. Billing must count
// usage-carrying rows, not raw assistant rows, or every tool boundary would
// bill as an extra run.

type PrismaQuery = { where: Record<string, unknown>; skip?: number };

const mocks = vi.hoisted(() => ({
  count: vi.fn(async (_query: { where: Record<string, unknown> }) => 0),
  aggregate: vi.fn(async (_query: { where: Record<string, unknown> }) => ({
    _count: { id: 0 },
    _sum: { inputTokens: 0, outputTokens: 0, cost: 0 },
  })),
  groupBy: vi.fn(async (_query: { where: Record<string, unknown> }) => []),
  findMany: vi.fn(async (_query: { where: Record<string, unknown>; skip?: number }) => []),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    aIMessage: {
      count: mocks.count,
      aggregate: mocks.aggregate,
      groupBy: mocks.groupBy,
      findMany: mocks.findMany,
    },
  },
  USAGE_CONFIG: { includedUnits: 50_000 },
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
  isAiRunBlocked: () => false,
  isRcaRunBlocked: () => false,
  isDetectorRunBlocked: () => false,
  isIngestionBlocked: () => false,
  DETECTOR_HOSTED_LLM_FREE_THRESHOLD: 0,
  AI_RUN_QUOTAS: { free: { included: 30 } },
  RCA_RUN_QUOTAS: { free: { included: 0 } },
  DETECTOR_RUN_QUOTAS: { free: { included: 0 } },
  EVENT_QUOTAS: { free: { included: 50_000 } },
}));

vi.mock("../clickhouse.js", () => ({ getWorkspaceUsageDetails: vi.fn() }));
vi.mock("../usageNotifications.js", () => ({ runUsageQuotaNotifications: vi.fn() }));

import { aggregateMessagesForKind, getOverageSystemModelCost } from "../usageMetering.js";

const WINDOW = {
  createTime: { gte: new Date("2026-08-01T00:00:00Z"), lt: new Date("2026-09-01T00:00:00Z") },
};

describe("run counting with segmented assistant rows", () => {
  beforeEach(() => {
    mocks.count.mockClear();
    mocks.findMany.mockClear();
  });

  it("counts a run only when the assistant row carries usage (the final segment)", async () => {
    await aggregateMessagesForKind("ws-1", "chat", WINDOW);
    expect(mocks.count).toHaveBeenCalledTimes(1);
    const where = (mocks.count.mock.calls[0]![0] as PrismaQuery).where;
    expect(where).toMatchObject({
      workspaceId: "ws-1",
      kind: "chat",
      role: "assistant",
      inputTokens: { not: null },
    });
  });

  it("locates the overage cutoff by skipping usage-carrying rows only", async () => {
    await getOverageSystemModelCost("ws-1", 100, WINDOW.createTime.gte, WINDOW.createTime.lt);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    const query = mocks.findMany.mock.calls[0]![0] as PrismaQuery;
    expect(query.skip).toBe(100);
    expect(query.where).toMatchObject({
      workspaceId: "ws-1",
      kind: "chat",
      role: "assistant",
      inputTokens: { not: null },
    });
  });
});
