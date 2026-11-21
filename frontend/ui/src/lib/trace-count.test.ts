import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb as db } from "./trace-count-test-db";

vi.mock("@traceroot/core", async () => ({
  prisma: (await import("./trace-count-test-db")).testDb.prisma,
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
}));

const analytics = vi.hoisted(() => ({
  enabled: true,
  sendServerPersonProperties: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
  isServerAnalyticsEnabled: () => analytics.enabled,
  sendServerPersonProperties: analytics.sendServerPersonProperties,
  captureServerEvent: vi.fn(),
}));

import {
  reportDailyTraceCounts,
  TRACE_COUNT_BATCH_SIZE,
  TRACE_COUNT_CLAIM_LEASE_MS,
  TRACE_COUNT_FAILURES_TO_STOP,
  TRACE_COUNT_TIME_BUDGET_MS,
} from "./trace-count";

const reportAt = (at: Date) => reportDailyTraceCounts(() => at);

const NOV_18 = new Date("2026-11-18T09:00:00Z");
const NOV_18_DAY = new Date("2026-11-18T00:00:00Z");
const NOV_19 = new Date("2026-11-19T00:15:00Z");
const later = (ms: number) => new Date(NOV_18.getTime() + ms);

/** What each person was sent, in send order. */
const sent = () =>
  analytics.sendServerPersonProperties.mock.calls.map(([userId, props]) => [
    userId,
    props.trace_count,
  ]);
const row = (userId: string) => db.tables.onboarding.find((r) => r.userId === userId);

function workspace(id: string, createdBy: string | null, traces?: number) {
  db.tables.workspaces.push({
    id,
    createdBy,
    currentUsage: traces === undefined ? null : { traces, spans: traces * 4 },
  });
}

beforeEach(() => {
  for (const table of Object.values(db.tables)) table.length = 0;
  analytics.enabled = true;
  analytics.sendServerPersonProperties.mockReset().mockResolvedValue(undefined);
  for (const id of ["user_sam", "user_ada", "user_lin"]) db.tables.users.push({ id });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reportDailyTraceCounts", () => {
  it("sends each owner the traces of the workspaces they own, added up", async () => {
    workspace("ws_1", "user_sam", 120);
    workspace("ws_2", "user_sam", 30);
    workspace("ws_3", "user_ada", 7);
    workspace("ws_4", "user_lin"); // usage not written yet

    expect(await reportAt(NOV_18)).toEqual({ kind: "sent", sent: 3, remaining: 0 });
    // None reported yet, so in id order.
    expect(sent()).toEqual([
      ["user_ada", 7],
      ["user_lin", 0],
      ["user_sam", 150],
    ]);
    expect(row("user_sam")).toMatchObject({
      traceCountReportedOn: NOV_18_DAY,
      traceCountClaimedAt: null,
    });
  });

  it("credits a workspace without a recorded creator to its earliest admin", async () => {
    workspace("ws_legacy", null, 42);
    db.tables.members.push(
      { workspaceId: "ws_legacy", userId: "user_lin", role: "MEMBER", createTime: new Date(1) },
      { workspaceId: "ws_legacy", userId: "user_sam", role: "ADMIN", createTime: new Date(3) },
      { workspaceId: "ws_legacy", userId: "user_ada", role: "ADMIN", createTime: new Date(2) },
    );

    await reportAt(NOV_18);

    expect(sent()).toEqual([["user_ada", 42]]);
  });

  it("leaves out the shared demo workspace", async () => {
    vi.stubEnv("DEMO_WORKSPACE_ID", "ws_demo");
    workspace("ws_demo", "user_sam", 1000);
    workspace("ws_1", "user_sam", 5);

    await reportAt(NOV_18);

    expect(sent()).toEqual([["user_sam", 5]]);
  });

  it("skips an owner whose user no longer exists", async () => {
    workspace("ws_orphan", "user_gone", 9);

    await reportAt(NOV_18);

    expect(sent()).toEqual([]);
    expect(db.tables.onboarding).toEqual([]);
  });

  it("sends each person once per UTC day, however often the tick runs", async () => {
    workspace("ws_1", "user_sam", 10);

    await reportAt(NOV_18);
    expect(await reportAt(later(10 * 60_000))).toEqual({
      kind: "sent",
      sent: 0,
      remaining: 0,
    });
    await reportAt(NOV_19);

    expect(sent()).toEqual([
      ["user_sam", 10],
      ["user_sam", 10],
    ]);
  });

  it("sends each person once when two ticks overlap", async () => {
    workspace("ws_1", "user_sam", 10);
    workspace("ws_2", "user_ada", 20);
    workspace("ws_3", "user_lin", 30);
    // Each send takes a few round trips, so one tick's send is in flight while the
    // other tick reaches the same person.
    analytics.sendServerPersonProperties.mockImplementation(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await Promise.all([reportAt(NOV_18), reportAt(later(1))]);

    expect(sent().sort()).toEqual([
      ["user_ada", 20],
      ["user_lin", 30],
      ["user_sam", 10],
    ]);
  });

  it("starts no send once the tick has used its time budget", async () => {
    workspace("ws_1", "user_ada", 10);
    workspace("ws_2", "user_sam", 20);
    let now = NOV_18;
    analytics.sendServerPersonProperties.mockImplementationOnce(async () => {
      now = later(TRACE_COUNT_TIME_BUDGET_MS);
    });

    expect(await reportDailyTraceCounts(() => now)).toEqual({
      kind: "sent",
      sent: 1,
      remaining: 1,
    });
    expect(sent()).toEqual([["user_ada", 10]]);
    expect(row("user_sam")).toBeUndefined();
  });

  it("gives a claim back unsent when the claim itself used up the budget", async () => {
    workspace("ws_1", "user_ada", 10);
    workspace("ws_2", "user_sam", 20);
    let now = NOV_18;
    // The database is slow: by the time Ada's claim returns, the budget is spent.
    const updateMany = db.prisma.userOnboarding.updateMany.getMockImplementation()!;
    db.prisma.userOnboarding.updateMany.mockImplementationOnce(async (args) => {
      const result = await updateMany(args);
      now = later(TRACE_COUNT_TIME_BUDGET_MS);
      return result;
    });

    expect(await reportDailyTraceCounts(() => now)).toEqual({
      kind: "sent",
      sent: 0,
      remaining: 2,
    });
    expect(sent()).toEqual([]);
    expect(row("user_ada")).toMatchObject({
      traceCountReportedOn: null,
      traceCountClaimedAt: null,
    });
    expect(row("user_sam")).toBeUndefined();

    // The next tick sends both as usual.
    expect(await reportAt(later(15 * 60_000))).toEqual({ kind: "sent", sent: 2, remaining: 0 });
    expect(sent()).toEqual([
      ["user_ada", 10],
      ["user_sam", 20],
    ]);
  });

  it("cancels a send still unanswered at the deadline and keeps that owner due", async () => {
    workspace("ws_1", "user_ada", 10);
    // The tick starts at NOV_18; its send starts with 5ms of the budget left and
    // PostHog never answers, so only the deadline's abort ends the request.
    let reads = 0;
    const clock = () => (reads++ === 0 ? NOV_18 : later(TRACE_COUNT_TIME_BUDGET_MS - 5));
    analytics.sendServerPersonProperties.mockImplementationOnce(
      (_userId: string, _props: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(await reportDailyTraceCounts(clock)).toEqual({ kind: "sent", sent: 0, remaining: 1 });
    } finally {
      logged.mockRestore();
    }
    // Not sent, and claimed until the lease runs out.
    expect(row("user_ada")).toMatchObject({
      traceCountReportedOn: null,
      traceCountClaimedAt: later(TRACE_COUNT_TIME_BUDGET_MS - 5),
    });

    // The next tick sends it; PostHog getting the same value twice is harmless.
    await reportAt(later(15 * 60_000));
    expect(sent()).toEqual([
      ["user_ada", 10],
      ["user_ada", 10],
    ]);
    expect(row("user_ada")).toMatchObject({ traceCountReportedOn: NOV_18_DAY });
  });

  it("skips a person another tick is sending right now", async () => {
    workspace("ws_1", "user_sam", 10);
    db.tables.onboarding.push({ userId: "user_sam", traceCountClaimedAt: later(-30_000) });

    expect(await reportAt(NOV_18)).toEqual({ kind: "sent", sent: 0, remaining: 1 });
    expect(sent()).toEqual([]);
  });

  it("takes over a claim left by a tick that died before sending", async () => {
    workspace("ws_1", "user_sam", 10);
    db.tables.onboarding.push({
      userId: "user_sam",
      traceCountClaimedAt: later(-TRACE_COUNT_CLAIM_LEASE_MS - 1),
    });

    await reportAt(NOV_18);

    expect(sent()).toEqual([["user_sam", 10]]);
    expect(row("user_sam")).toMatchObject({
      traceCountReportedOn: NOV_18_DAY,
      traceCountClaimedAt: null,
    });
  });

  it("keeps an owner whose send failed due, and goes on with the others", async () => {
    workspace("ws_1", "user_sam", 10);
    workspace("ws_2", "user_ada", 20);
    workspace("ws_3", "user_lin", 30);
    analytics.sendServerPersonProperties
      .mockResolvedValueOnce(undefined) // Ada
      .mockRejectedValueOnce(new Error("PostHog answered 503")); // Lin
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(await reportAt(NOV_18)).toEqual({ kind: "sent", sent: 2, remaining: 1 });
    } finally {
      logged.mockRestore();
    }
    expect(row("user_lin")).toMatchObject({
      traceCountReportedOn: null,
      traceCountClaimedAt: NOV_18,
    });
    expect(row("user_sam")).toMatchObject({ traceCountReportedOn: NOV_18_DAY });

    // Inside the lease nobody retries Lin; after it, the next tick sends only Lin.
    expect(await reportAt(later(60_000))).toEqual({ kind: "sent", sent: 0, remaining: 1 });
    expect(await reportAt(later(15 * 60_000))).toEqual({ kind: "sent", sent: 1, remaining: 0 });
    expect(sent()).toEqual([
      ["user_ada", 20],
      ["user_lin", 30], // the failed attempt
      ["user_sam", 10],
      ["user_lin", 30],
    ]);
  });

  it("does not let one owner whose delivery keeps failing hold up the rest", async () => {
    workspace("ws_1", "user_ada", 10);
    analytics.sendServerPersonProperties.mockImplementation(async (userId: string) => {
      if (userId === "user_ada") throw new Error("PostHog answered 400");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await reportAt(NOV_18);
      // Two owners join later the same day; Ada, who already failed, goes after them.
      workspace("ws_2", "user_sam", 20);
      workspace("ws_3", "user_lin", 30);
      expect(await reportAt(later(15 * 60_000))).toEqual({ kind: "sent", sent: 2, remaining: 1 });
      expect(await reportAt(later(30 * 60_000))).toEqual({ kind: "sent", sent: 0, remaining: 1 });
    } finally {
      logged.mockRestore();
    }
    expect(sent().map(([userId]) => userId)).toEqual([
      "user_ada",
      "user_lin",
      "user_sam",
      "user_ada",
      "user_ada",
    ]);
    // Still due, and retried every tick.
    expect(row("user_ada")).toMatchObject({ traceCountReportedOn: null });
  });

  it("ends the tick after several failures in a row: PostHog itself is failing", async () => {
    for (const id of ["user_ada", "user_lin", "user_sam"]) workspace(`ws_${id}`, id, 1);
    db.tables.users.push({ id: "user_zoe" });
    workspace("ws_zoe", "user_zoe", 1);
    analytics.sendServerPersonProperties.mockRejectedValue(new Error("PostHog answered 503"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(await reportAt(NOV_18)).toEqual({ kind: "sent", sent: 0, remaining: 4 });
    } finally {
      logged.mockRestore();
    }
    expect(sent()).toHaveLength(TRACE_COUNT_FAILURES_TO_STOP);
    expect(row("user_zoe")).toBeUndefined();
  });

  it("an interrupted tick, retried after an overlapping one, sends each count once", async () => {
    workspace("ws_1", "user_sam", 10);
    workspace("ws_2", "user_ada", 20);
    workspace("ws_3", "user_lin", 30);
    // Tick A claimed Sam and died before its send reached PostHog.
    db.tables.onboarding.push({ userId: "user_sam", traceCountClaimedAt: NOV_18 });

    await reportAt(later(10_000)); // tick B, overlapping A
    await reportAt(later(TRACE_COUNT_CLAIM_LEASE_MS + 60_000)); // A, retried

    expect(sent().sort()).toEqual([
      ["user_ada", 20],
      ["user_lin", 30],
      ["user_sam", 10],
    ]);
  });

  it("claims a person through the onboarding row first-trace tracking already made", async () => {
    workspace("ws_1", "user_sam", 10);
    db.tables.onboarding.push({ userId: "user_sam", lastActiveDay: NOV_18_DAY });

    await reportAt(NOV_18);

    expect(sent()).toEqual([["user_sam", 10]]);
    expect(row("user_sam")).toMatchObject({
      lastActiveDay: NOV_18_DAY,
      traceCountReportedOn: NOV_18_DAY,
    });
  });

  it("leaves the people past one batch to the next tick", async () => {
    const extra = 3;
    for (let i = 0; i < TRACE_COUNT_BATCH_SIZE + extra; i += 1) {
      db.tables.users.push({ id: `user_${i}` });
      workspace(`ws_${i}`, `user_${i}`, i);
    }

    expect(await reportAt(NOV_18)).toEqual({
      kind: "sent",
      sent: TRACE_COUNT_BATCH_SIZE,
      remaining: extra,
    });
    expect(await reportAt(later(15 * 60_000))).toEqual({
      kind: "sent",
      sent: extra,
      remaining: 0,
    });
    expect(new Set(sent().map(([userId]) => userId)).size).toBe(TRACE_COUNT_BATCH_SIZE + extra);
  });

  it("reaches tomorrow first the owners today's ticks could not", async () => {
    // More owners than the day's ticks can reach: here, one tick's batch.
    const owners = TRACE_COUNT_BATCH_SIZE + 3;
    const id = (i: number) => `user_${String(i).padStart(3, "0")}`;
    for (let i = 0; i < owners; i += 1) {
      db.tables.users.push({ id: id(i) });
      workspace(`ws_${i}`, id(i), i);
    }

    await reportAt(new Date("2026-11-18T23:50:00Z")); // the day's last tick
    const leftOut = [id(owners - 3), id(owners - 2), id(owners - 1)];
    const reachedToday = new Set(sent().map(([userId]) => userId));
    expect(leftOut.filter((userId) => reachedToday.has(userId))).toEqual([]);

    analytics.sendServerPersonProperties.mockClear();
    await reportAt(NOV_19); // the next day's first tick
    expect(
      sent()
        .slice(0, 3)
        .map(([userId]) => userId),
    ).toEqual(leftOut);
    expect(sent()).toHaveLength(TRACE_COUNT_BATCH_SIZE);
  });

  it("does nothing on a deployment without server analytics", async () => {
    analytics.enabled = false;
    workspace("ws_1", "user_sam", 10);

    expect(await reportAt(NOV_18)).toEqual({ kind: "analytics_off" });
    expect(db.tables.onboarding).toEqual([]);
    expect(sent()).toEqual([]);
  });
});
