import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

/**
 * An in-memory stand-in for the slice of Prisma this module uses. Each query
 * yields once before it runs, as a database round trip would, and a conditional
 * update filters and writes in one step, so overlapping ticks interleave between
 * queries but never inside one.
 */
const db = vi.hoisted(() => {
  const tables = {
    workspaces: [] as Row[],
    members: [] as Row[],
    users: [] as Row[],
    onboarding: [] as Row[],
  };

  /** Equality, null, `lt`, `OR` and `AND`: the conditions the module writes. */
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return (condition as Row[]).some((c) => matches(row, c));
      if (key === "AND") return (condition as Row[]).every((c) => matches(row, c));
      const value = row[key] ?? null;
      if (condition === null) return value === null;
      if (condition instanceof Date) {
        return value instanceof Date && value.getTime() === condition.getTime();
      }
      const { lt } = condition as { lt?: Date };
      if (lt !== undefined) return value instanceof Date && value.getTime() < lt.getTime();
      return value === condition;
    });
  }

  const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 0));

  const prisma = {
    workspace: {
      findMany: vi.fn(async ({ where }: { where: { id?: { not: string } } }) => {
        await roundTrip();
        return tables.workspaces
          .filter((ws) => where.id === undefined || ws.id !== where.id.not)
          .map((ws) => ({
            createdBy: ws.createdBy ?? null,
            currentUsage: ws.currentUsage ?? null,
            members: tables.members
              .filter((m) => m.workspaceId === ws.id && m.role === "ADMIN")
              .sort((a, b) => (a.createTime as Date).getTime() - (b.createTime as Date).getTime())
              .slice(0, 1)
              .map((m) => ({ userId: m.userId })),
          }));
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        await roundTrip();
        return tables.users.filter((u) => where.id.in.includes(u.id as string));
      }),
    },
    userOnboarding: {
      findMany: vi.fn(async ({ where }: { where: Row }) => {
        await roundTrip();
        return tables.onboarding.filter((row) => matches(row, where));
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        await roundTrip();
        const rows = tables.onboarding.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        await roundTrip();
        if (tables.onboarding.some((row) => row.userId === data.userId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        tables.onboarding.push({ traceCountReportedOn: null, traceCountClaimedAt: null, ...data });
        return data;
      }),
    },
  };
  return { tables, prisma };
});

vi.mock("@traceroot/core", () => ({
  prisma: db.prisma,
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
} from "./trace-count";

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

    expect(await reportDailyTraceCounts(NOV_18)).toEqual({ kind: "sent", sent: 3, remaining: 0 });
    expect(sent()).toEqual([
      ["user_sam", 150],
      ["user_ada", 7],
      ["user_lin", 0],
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

    await reportDailyTraceCounts(NOV_18);

    expect(sent()).toEqual([["user_ada", 42]]);
  });

  it("leaves out the shared demo workspace", async () => {
    vi.stubEnv("DEMO_WORKSPACE_ID", "ws_demo");
    workspace("ws_demo", "user_sam", 1000);
    workspace("ws_1", "user_sam", 5);

    await reportDailyTraceCounts(NOV_18);

    expect(sent()).toEqual([["user_sam", 5]]);
  });

  it("skips an owner whose user no longer exists", async () => {
    workspace("ws_orphan", "user_gone", 9);

    await reportDailyTraceCounts(NOV_18);

    expect(sent()).toEqual([]);
    expect(db.tables.onboarding).toEqual([]);
  });

  it("sends each person once per UTC day, however often the tick runs", async () => {
    workspace("ws_1", "user_sam", 10);

    await reportDailyTraceCounts(NOV_18);
    expect(await reportDailyTraceCounts(later(10 * 60_000))).toEqual({
      kind: "sent",
      sent: 0,
      remaining: 0,
    });
    await reportDailyTraceCounts(NOV_19);

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

    await Promise.all([reportDailyTraceCounts(NOV_18), reportDailyTraceCounts(later(1))]);

    expect(sent().sort()).toEqual([
      ["user_ada", 20],
      ["user_lin", 30],
      ["user_sam", 10],
    ]);
  });

  it("skips a person another tick is sending right now", async () => {
    workspace("ws_1", "user_sam", 10);
    db.tables.onboarding.push({ userId: "user_sam", traceCountClaimedAt: later(-30_000) });

    expect(await reportDailyTraceCounts(NOV_18)).toEqual({ kind: "sent", sent: 0, remaining: 1 });
    expect(sent()).toEqual([]);
  });

  it("takes over a claim left by a tick that died before sending", async () => {
    workspace("ws_1", "user_sam", 10);
    db.tables.onboarding.push({
      userId: "user_sam",
      traceCountClaimedAt: later(-TRACE_COUNT_CLAIM_LEASE_MS - 1),
    });

    await reportDailyTraceCounts(NOV_18);

    expect(sent()).toEqual([["user_sam", 10]]);
    expect(row("user_sam")).toMatchObject({
      traceCountReportedOn: NOV_18_DAY,
      traceCountClaimedAt: null,
    });
  });

  it("gives a send PostHog does not accept back and ends the tick", async () => {
    workspace("ws_1", "user_sam", 10);
    workspace("ws_2", "user_ada", 20);
    workspace("ws_3", "user_lin", 30);
    analytics.sendServerPersonProperties
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("PostHog unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await reportDailyTraceCounts(NOV_18)).toEqual({ kind: "sent", sent: 1, remaining: 2 });
    expect(row("user_ada")).toMatchObject({
      traceCountReportedOn: null,
      traceCountClaimedAt: null,
    });
    expect(row("user_lin")).toBeUndefined();

    await reportDailyTraceCounts(later(15 * 60_000));
    expect(sent()).toEqual([
      ["user_sam", 10],
      ["user_ada", 20], // the failed attempt
      ["user_ada", 20],
      ["user_lin", 30],
    ]);
  });

  it("an interrupted tick, retried after an overlapping one, sends each count once", async () => {
    workspace("ws_1", "user_sam", 10);
    workspace("ws_2", "user_ada", 20);
    workspace("ws_3", "user_lin", 30);
    // Tick A claimed Sam and died before its send reached PostHog.
    db.tables.onboarding.push({ userId: "user_sam", traceCountClaimedAt: NOV_18 });

    await reportDailyTraceCounts(later(10_000)); // tick B, overlapping A
    await reportDailyTraceCounts(later(TRACE_COUNT_CLAIM_LEASE_MS + 60_000)); // A, retried

    expect(sent().sort()).toEqual([
      ["user_ada", 20],
      ["user_lin", 30],
      ["user_sam", 10],
    ]);
  });

  it("claims a person through the onboarding row first-trace tracking already made", async () => {
    workspace("ws_1", "user_sam", 10);
    db.tables.onboarding.push({ userId: "user_sam", lastActiveDay: NOV_18_DAY });

    await reportDailyTraceCounts(NOV_18);

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

    expect(await reportDailyTraceCounts(NOV_18)).toEqual({
      kind: "sent",
      sent: TRACE_COUNT_BATCH_SIZE,
      remaining: extra,
    });
    expect(await reportDailyTraceCounts(later(15 * 60_000))).toEqual({
      kind: "sent",
      sent: extra,
      remaining: 0,
    });
    expect(new Set(sent().map(([userId]) => userId)).size).toBe(TRACE_COUNT_BATCH_SIZE + extra);
  });

  it("does nothing on a deployment without server analytics", async () => {
    analytics.enabled = false;
    workspace("ws_1", "user_sam", 10);

    expect(await reportDailyTraceCounts(NOV_18)).toEqual({ kind: "analytics_off" });
    expect(db.tables.onboarding).toEqual([]);
    expect(sent()).toEqual([]);
  });
});
