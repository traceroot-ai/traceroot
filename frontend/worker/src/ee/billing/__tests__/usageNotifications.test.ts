import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notifFindMany: vi.fn(),
  notifUpsert: vi.fn(),
  memberFindMany: vi.fn(),
  sendUsageQuotaEmail: vi.fn(),
  isBillingEnabled: vi.fn(() => true),
}));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    isBillingEnabled: mocks.isBillingEnabled,
    prisma: {
      workspaceUsageNotification: {
        findMany: mocks.notifFindMany,
        upsert: mocks.notifUpsert,
      },
      workspaceMember: { findMany: mocks.memberFindMany },
    },
  };
});

vi.mock("../../../notifications/email.js", () => ({
  sendUsageQuotaEmail: mocks.sendUsageQuotaEmail,
}));

import { runUsageQuotaNotifications } from "../usageNotifications.js";

const EPOCH = new Date(0);
const NOW = new Date("2026-07-06T12:00:00Z");

function baseArgs(
  meters: Array<{ meter: "events" | "rca" | "detector"; used: number; cap: number }>,
) {
  return {
    workspaceId: "ws-1",
    workspaceName: "Acme",
    periodStart: EPOCH,
    now: NOW,
    meters,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isBillingEnabled.mockReturnValue(true);
  mocks.notifFindMany.mockResolvedValue([]);
  mocks.notifUpsert.mockResolvedValue({});
  mocks.memberFindMany.mockResolvedValue([
    { user: { email: "admin@example.com" } },
    { user: { email: "owner@example.com" } },
  ]);
  mocks.sendUsageQuotaEmail.mockResolvedValue(true);
});

describe("runUsageQuotaNotifications", () => {
  it("sends a warning to admin emails and stamps only the warning", async () => {
    await runUsageQuotaNotifications(baseArgs([{ meter: "events", used: 40_000, cap: 50_000 }]));

    expect(mocks.sendUsageQuotaEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendUsageQuotaEmail).toHaveBeenCalledWith({
      to: ["admin@example.com", "owner@example.com"],
      kind: "warning",
      meter: "events",
      workspaceId: "ws-1",
      workspaceName: "Acme",
      used: 40_000,
      cap: 50_000,
    });
    expect(mocks.notifUpsert).toHaveBeenCalledTimes(1);
    const upsert = mocks.notifUpsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ workspaceId_meter: { workspaceId: "ws-1", meter: "events" } });
    expect(upsert.create.warningSentAt).toEqual(NOW);
    expect(upsert.create.blockedSentAt).toBeNull();
    expect(upsert.create.periodStart).toEqual(EPOCH);
  });

  it("sends only the blocked email but stamps both when the cap is first crossed", async () => {
    await runUsageQuotaNotifications(baseArgs([{ meter: "rca", used: 30, cap: 30 }]));

    expect(mocks.sendUsageQuotaEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendUsageQuotaEmail.mock.calls[0][0].kind).toBe("blocked");
    const upsert = mocks.notifUpsert.mock.calls[0][0];
    expect(upsert.create.warningSentAt).toEqual(NOW);
    expect(upsert.create.blockedSentAt).toEqual(NOW);
  });

  it("does not stamp when the send fails, so the next run retries", async () => {
    mocks.sendUsageQuotaEmail.mockResolvedValue(false);
    await runUsageQuotaNotifications(baseArgs([{ meter: "events", used: 50_000, cap: 50_000 }]));

    expect(mocks.sendUsageQuotaEmail).toHaveBeenCalledTimes(1);
    expect(mocks.notifUpsert).not.toHaveBeenCalled();
  });

  it("sends nothing when both thresholds are already stamped for this window", async () => {
    mocks.notifFindMany.mockResolvedValue([
      {
        meter: "events",
        periodStart: EPOCH,
        warningSentAt: new Date("2026-07-01T00:00:00Z"),
        blockedSentAt: new Date("2026-07-02T00:00:00Z"),
      },
    ]);
    await runUsageQuotaNotifications(baseArgs([{ meter: "events", used: 60_000, cap: 50_000 }]));

    expect(mocks.sendUsageQuotaEmail).not.toHaveBeenCalled();
    expect(mocks.notifUpsert).not.toHaveBeenCalled();
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });

  it("treats a row from a different usage window as unsent and resets stale stamps", async () => {
    mocks.notifFindMany.mockResolvedValue([
      {
        meter: "events",
        periodStart: new Date("2026-06-01T00:00:00Z"),
        warningSentAt: new Date("2026-06-05T00:00:00Z"),
        blockedSentAt: new Date("2026-06-09T00:00:00Z"),
      },
    ]);
    await runUsageQuotaNotifications(baseArgs([{ meter: "events", used: 40_000, cap: 50_000 }]));

    expect(mocks.sendUsageQuotaEmail.mock.calls[0][0].kind).toBe("warning");
    const upsert = mocks.notifUpsert.mock.calls[0][0];
    expect(upsert.update.periodStart).toEqual(EPOCH);
    expect(upsert.update.warningSentAt).toEqual(NOW);
    expect(upsert.update.blockedSentAt).toBeNull(); // stale stamp from the old window cleared
  });

  it("processes meters independently in one call", async () => {
    await runUsageQuotaNotifications(
      baseArgs([
        { meter: "events", used: 10_000, cap: 50_000 }, // quiet
        { meter: "rca", used: 25, cap: 30 }, // warning
        { meter: "detector", used: 100, cap: 100 }, // blocked
      ]),
    );

    expect(mocks.sendUsageQuotaEmail).toHaveBeenCalledTimes(2);
    const kinds = mocks.sendUsageQuotaEmail.mock.calls.map((c) => [c[0].meter, c[0].kind]);
    expect(kinds).toEqual([
      ["rca", "warning"],
      ["detector", "blocked"],
    ]);
    expect(mocks.memberFindMany).toHaveBeenCalledTimes(1); // admin list fetched once
  });

  it("does nothing at all when billing is disabled", async () => {
    mocks.isBillingEnabled.mockReturnValue(false);
    await runUsageQuotaNotifications(baseArgs([{ meter: "events", used: 60_000, cap: 50_000 }]));

    expect(mocks.notifFindMany).not.toHaveBeenCalled();
    expect(mocks.sendUsageQuotaEmail).not.toHaveBeenCalled();
  });
});
