import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

/**
 * An in-memory stand-in for the slice of Prisma this module uses. Each query
 * yields once before it runs, as a round trip to the database would, and then
 * filters and writes in one step, as a conditional UPDATE does. Concurrent
 * reports therefore interleave between queries but never inside one, which is
 * the property the module relies on.
 */
const db = vi.hoisted(() => {
  const tables = {
    workspaces: [] as Row[],
    projects: [] as Row[],
    members: [] as Row[],
    users: [] as Row[],
    onboarding: [] as Row[],
    tracking: [] as Row[],
  };

  const sameTime = (a: unknown, b: Date) => a instanceof Date && a.getTime() === b.getTime();

  /** Equality, null, `lt`, `gt`, `gte`, `has`, `OR` and `NOT`: the conditions the module writes. */
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return (condition as Row[]).some((c) => matches(row, c));
      if (key === "NOT")
        return ([] as Row[]).concat(condition as Row).every((c) => !matches(row, c));
      const value = row[key] ?? null;
      if (condition === null) return value === null;
      if (condition instanceof Date) return sameTime(value, condition);
      if (typeof condition === "object") {
        const { lt, gt, gte, has } = condition as {
          lt?: Date;
          gt?: Date;
          gte?: number;
          has?: Date;
        };
        if (lt !== undefined) return value instanceof Date && value.getTime() < lt.getTime();
        if (gt !== undefined) return value instanceof Date && value.getTime() > gt.getTime();
        if (gte !== undefined) return typeof value === "number" && value >= gte;
        if (has !== undefined) return Array.isArray(value) && value.some((v) => sameTime(v, has));
      }
      return value === condition;
    });
  }

  function apply(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      const { increment, push } = (value ?? {}) as { increment?: number; push?: unknown };
      if (increment !== undefined) row[key] = (row[key] as number) + increment;
      else if (push !== undefined)
        row[key] = [...((row[key] as unknown[] | undefined) ?? []), push];
      else row[key] = value;
    }
  }

  const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 0));

  const updateMany = (table: Row[]) =>
    vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      await roundTrip();
      const rows = table.filter((row) => matches(row, where));
      rows.forEach((row) => apply(row, data));
      return { count: rows.length };
    });

  const prisma = {
    project: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        await roundTrip();
        const project = tables.projects.find((row) => matches(row, where));
        if (!project) return null;
        const workspace = tables.workspaces.find((row) => row.id === project.workspaceId);
        return {
          workspaceId: project.workspaceId,
          firstTraceReceiveTime: project.firstTraceReceiveTime ?? null,
          workspace: { createdBy: workspace?.createdBy ?? null },
        };
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        await roundTrip();
        const project = tables.projects.find((row) => row.id === where.id);
        return project ? { firstTraceReceiveTime: project.firstTraceReceiveTime ?? null } : null;
      }),
      updateMany: updateMany(tables.projects),
    },
    workspaceMember: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        await roundTrip();
        const [first] = tables.members
          .filter((row) => matches(row, where))
          .sort((a, b) => (a.createTime as Date).getTime() - (b.createTime as Date).getTime());
        return first ? { userId: first.userId } : null;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        await roundTrip();
        const user = tables.users.find((row) => row.id === where.id);
        return user ? { createdAt: user.createdAt } : null;
      }),
    },
    userOnboarding: {
      updateMany: updateMany(tables.onboarding),
      create: vi.fn(async ({ data }: { data: Row }) => {
        await roundTrip();
        if (tables.onboarding.some((row) => row.userId === data.userId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = {
          lastActiveDay: null,
          countedDays: [],
          activeDaysFirstWeek: 0,
          activeWeekAt: null,
          ...data,
        };
        tables.onboarding.push(row);
        return row;
      }),
    },
    firstTraceTracking: {
      findUnique: vi.fn(async () => {
        await roundTrip();
        return tables.tracking[0] ? { startedAt: tables.tracking[0].startedAt } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        await roundTrip();
        if (tables.tracking.length) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        tables.tracking.push({ ...data });
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

const { captureServerEvent } = vi.hoisted(() => ({ captureServerEvent: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent }));

// The trace store's answer is stated per test; the start of recording and filling
// the time run for real.
const { readFirstTraceReceiveTime } = vi.hoisted(() => ({ readFirstTraceReceiveTime: vi.fn() }));
vi.mock("@/lib/first-trace-backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/first-trace-backfill")>()),
  readFirstTraceReceiveTime,
}));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "internal-test-secret" } }));

import { utcDay } from "@/lib/utc-day";
import {
  ACTIVE_FIRST_WEEK_DAYS,
  recordTraceActivity,
  type TraceActivityOutcome,
} from "./trace-activity";

/** Sam signs up on 10 November; `at(n)` is noon UTC on day n of their first week. */
const SIGNED_UP = new Date("2026-11-10T09:00:00Z");
/** When the ingest worker started reporting, as it recorded before its first report. */
const REPORTING_STARTED = new Date("2026-11-09T00:00:00Z");
const at = (day: number, time = "12:00:00") =>
  new Date(`2026-11-${String(10 + day).padStart(2, "0")}T${time}Z`);

const events = (name: string) =>
  captureServerEvent.mock.calls.filter(([, event]) => event === name);
const firstTrace = (outcome: TraceActivityOutcome) =>
  outcome.kind === "recorded" && outcome.firstTrace;
const dayCounted = (outcome: TraceActivityOutcome) =>
  outcome.kind === "recorded" && outcome.activeDayCounted;

beforeEach(() => {
  for (const table of Object.values(db.tables)) table.length = 0;
  captureServerEvent.mockReset();
  // By default the store does not show the batch yet, and the report is taken at its word.
  readFirstTraceReceiveTime.mockReset().mockResolvedValue(null);
  db.tables.tracking.push({ id: 1, startedAt: REPORTING_STARTED });
  db.tables.users.push({ id: "user_sam", createdAt: SIGNED_UP });
  db.tables.workspaces.push({ id: "ws_sam", createdBy: "user_sam" });
  db.tables.projects.push(
    { id: "proj_a", workspaceId: "ws_sam", deleteTime: null, firstTraceReceiveTime: null },
    { id: "proj_b", workspaceId: "ws_sam", deleteTime: null, firstTraceReceiveTime: null },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a project's first trace", () => {
  it("is recorded once, on the workspace creator, however often it is reported", async () => {
    const outcomes = [
      await recordTraceActivity("proj_a", at(0)),
      await recordTraceActivity("proj_a", at(0, "12:05:00")), // a retry the same day
      await recordTraceActivity("proj_a", at(1)), // the next day's report
    ];

    expect(outcomes.map(firstTrace)).toEqual([true, false, false]);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0));
    expect(events("first_trace_received")).toEqual([
      ["user_sam", "first_trace_received", { project_id: "proj_a", workspace_id: "ws_sam" }, at(0)],
    ]);
  });

  it("is recorded once when two reports for a new project arrive together", async () => {
    const outcomes = await Promise.all([
      recordTraceActivity("proj_a", at(0)),
      recordTraceActivity("proj_a", at(0)),
    ]);

    expect(outcomes.filter(firstTrace)).toHaveLength(1);
    expect(events("first_trace_received")).toHaveLength(1);
  });

  it("is tracked for each project on its own", async () => {
    await recordTraceActivity("proj_a", at(0));
    await recordTraceActivity("proj_b", at(2));

    expect(events("first_trace_received").map(([, , props]) => props.project_id)).toEqual([
      "proj_a",
      "proj_b",
    ]);
  });

  it("is credited to the earliest admin of a workspace without a recorded creator", async () => {
    db.tables.workspaces[0].createdBy = null;
    db.tables.users.push({ id: "user_ada", createdAt: SIGNED_UP });
    db.tables.members.push(
      { workspaceId: "ws_sam", userId: "user_viewer", role: "VIEWER", createTime: at(-3) },
      { workspaceId: "ws_sam", userId: "user_sam", role: "ADMIN", createTime: at(-1) },
      { workspaceId: "ws_sam", userId: "user_ada", role: "ADMIN", createTime: at(-2) },
    );

    await recordTraceActivity("proj_a", at(0));

    expect(events("first_trace_received").map(([distinctId]) => distinctId)).toEqual(["user_ada"]);
  });

  it("is still recorded when the workspace has nobody to credit, without any event", async () => {
    db.tables.workspaces[0].createdBy = null;

    const outcome = await recordTraceActivity("proj_a", at(0));

    expect(outcome).toEqual({
      kind: "recorded",
      firstTrace: true,
      activeDayCounted: false,
      activeFirstWeek: false,
    });
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0));
    expect(captureServerEvent).not.toHaveBeenCalled();
  });
});

describe("reports that record nothing", () => {
  it("leaves a project in the demo workspace untouched", async () => {
    vi.stubEnv("DEMO_WORKSPACE_ID", "ws_sam");

    expect(await recordTraceActivity("proj_a", at(0))).toEqual({ kind: "demo_project" });
    expect(db.tables.projects[0].firstTraceReceiveTime).toBeNull();
    expect(db.tables.onboarding).toEqual([]);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["a project that does not exist", "proj_missing"],
    ["a deleted project", "proj_deleted"],
  ])("answers unknown_project for %s", async (_, projectId) => {
    db.tables.projects.push({
      id: "proj_deleted",
      workspaceId: "ws_sam",
      deleteTime: at(-1),
      firstTraceReceiveTime: null,
    });

    expect(await recordTraceActivity(projectId, at(0))).toEqual({ kind: "unknown_project" });
    expect(db.tables.projects.every((row) => row.firstTraceReceiveTime === null)).toBe(true);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });
});

describe("an active first week", () => {
  it(`counts each UTC day once and is marked on the ${ACTIVE_FIRST_WEEK_DAYS}rd day with traces`, async () => {
    await recordTraceActivity("proj_a", at(0));
    await recordTraceActivity("proj_b", at(0, "18:00:00")); // same day, another project
    await recordTraceActivity("proj_a", at(2));
    const third = await recordTraceActivity("proj_b", at(5));
    await recordTraceActivity("proj_a", at(6));

    expect(third).toMatchObject({ activeDayCounted: true, activeFirstWeek: true });
    expect(db.tables.onboarding).toHaveLength(1);
    expect(db.tables.onboarding[0]).toMatchObject({ activeDaysFirstWeek: 4, activeWeekAt: at(5) });
    expect(events("active_first_week")).toEqual([
      ["user_sam", "active_first_week", { project_id: "proj_b", workspace_id: "ws_sam" }],
    ]);
  });

  it("counts a day once when two projects report it together", async () => {
    const outcomes = await Promise.all([
      recordTraceActivity("proj_a", at(0)),
      recordTraceActivity("proj_b", at(0)),
    ]);

    expect(outcomes.filter(dayCounted)).toHaveLength(1);
    expect(db.tables.onboarding).toEqual([
      expect.objectContaining({ userId: "user_sam", activeDaysFirstWeek: 1 }),
    ]);
  });

  it("covers the sign-up day and the six after it, by UTC calendar day", async () => {
    // Signed up half an hour before midnight UTC: a report an hour later is
    // already day 1, and the week ends at midnight UTC after day 6.
    db.tables.users[0].createdAt = new Date("2026-11-10T23:30:00Z");

    const outcomes = [
      await recordTraceActivity("proj_a", new Date("2026-11-09T23:59:00Z")), // a clock behind sign-up
      await recordTraceActivity("proj_a", new Date("2026-11-11T00:30:00Z")),
      await recordTraceActivity("proj_a", new Date("2026-11-16T23:59:59Z")),
      await recordTraceActivity("proj_a", new Date("2026-11-17T00:00:00Z")),
    ];

    expect(outcomes.map(dayCounted)).toEqual([false, true, true, false]);
  });

  it("finishes marking a week that an interrupted report left unmarked", async () => {
    db.tables.onboarding.push({
      userId: "user_sam",
      lastActiveDay: new Date("2026-11-12T00:00:00Z"),
      countedDays: [
        new Date("2026-11-10T00:00:00Z"),
        new Date("2026-11-11T00:00:00Z"),
        new Date("2026-11-12T00:00:00Z"),
      ],
      activeDaysFirstWeek: ACTIVE_FIRST_WEEK_DAYS,
      activeWeekAt: null,
    });

    const sameDay = await recordTraceActivity("proj_a", at(2, "20:00:00"));
    await recordTraceActivity("proj_a", at(3));

    expect(sameDay).toMatchObject({ activeDayCounted: false, activeFirstWeek: true });
    expect(events("active_first_week")).toHaveLength(1);
  });
});

describe("the day a report counts", () => {
  /** Midnight UTC of day n of Sam's first week, as the worker reports a day. */
  const day = (n: number) => utcDay(at(n));
  const counted = () => db.tables.onboarding[0]?.activeDaysFirstWeek;

  it("is the day the traces were received, which a retry past midnight keeps", async () => {
    // Traces on day 0; their report kept failing until half a minute after midnight.
    const late = await recordTraceActivity("proj_a", at(1, "00:00:30"), day(0));
    const next = await recordTraceActivity("proj_a", at(1), day(1));

    expect([late, next].map(dayCounted)).toEqual([true, true]);
    expect(db.tables.onboarding[0]).toMatchObject({
      activeDaysFirstWeek: 2,
      lastActiveDay: day(1),
      countedDays: [day(0), day(1)],
    });
  });

  it("counts two days once each when the later day's report arrives first", async () => {
    const outcomes = [
      await recordTraceActivity("proj_a", at(2), day(2)),
      // A batch from day 1 that waited in the queue, or a report retried for a day.
      await recordTraceActivity("proj_b", at(2, "12:01:00"), day(1)),
    ];

    expect(outcomes.map(dayCounted)).toEqual([true, true]);
    expect(db.tables.onboarding[0]).toMatchObject({
      activeDaysFirstWeek: 2,
      lastActiveDay: day(2),
    });
  });

  it("counts a repeated report for either day once", async () => {
    const outcomes: TraceActivityOutcome[] = [];
    for (const n of [2, 1, 1, 2, 1]) {
      outcomes.push(await recordTraceActivity("proj_a", at(2), day(n)));
    }

    expect(outcomes.map(dayCounted)).toEqual([true, true, false, false, false]);
    expect(counted()).toBe(2);
  });

  it("counts each day once when reports for two days arrive together", async () => {
    const outcomes = await Promise.all([
      recordTraceActivity("proj_a", at(2), day(2)),
      recordTraceActivity("proj_b", at(2), day(1)),
      recordTraceActivity("proj_a", at(2), day(1)),
      recordTraceActivity("proj_b", at(2), day(2)),
    ]);

    expect(outcomes.filter(dayCounted)).toHaveLength(2);
    expect(counted()).toBe(2);
  });

  it("does not count again the latest day a receiver without the list of days counted", async () => {
    // The row as a receiver from before the list leaves it during a rollout.
    db.tables.onboarding.push({
      userId: "user_sam",
      lastActiveDay: day(1),
      countedDays: [],
      activeDaysFirstWeek: 1,
      activeWeekAt: null,
    });

    const outcomes = [
      await recordTraceActivity("proj_a", at(1), day(1)),
      await recordTraceActivity("proj_a", at(2), day(0)),
    ];

    expect(outcomes.map(dayCounted)).toEqual([false, true]);
    expect(db.tables.onboarding[0]).toMatchObject({
      activeDaysFirstWeek: 2,
      lastActiveDay: day(1),
    });
  });

  it("is the day the report arrives when the worker sends none", async () => {
    await recordTraceActivity("proj_a", at(3));

    expect(db.tables.onboarding[0]).toMatchObject({ lastActiveDay: day(3), countedDays: [day(3)] });
  });

  it("counts nothing for a reported day outside the owner's first week", async () => {
    const outcomes = [
      await recordTraceActivity("proj_a", at(0), day(-1)), // the day before sign-up
      await recordTraceActivity("proj_a", at(8), day(7)), // the day after the week
    ];

    expect(outcomes.map(dayCounted)).toEqual([false, false]);
    expect(db.tables.onboarding).toEqual([]);
  });
});

describe("projects with traces from before reporting started", () => {
  const START = at(0, "10:00:00");
  const OCT_11 = new Date("2026-10-11T08:30:00Z");
  const startedRecording = () => db.tables.tracking.splice(0, 1, { id: 1, startedAt: START });

  it("does not send first_trace_received for a first trace an hour before the start", async () => {
    startedRecording();
    readFirstTraceReceiveTime.mockResolvedValue(at(0, "09:00:00"));

    const outcome = await recordTraceActivity("proj_a", at(0));

    expect(firstTrace(outcome)).toBe(false);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0, "09:00:00"));
    expect(events("first_trace_received")).toEqual([]);
  });

  it("sends it for a first trace after the start, at the store's receive time", async () => {
    // The report gets through two hours after the trace was stored, after retries. The
    // event is placed at the store's receive time, so a funnel from an earlier step
    // counts it within its window by that time, not by the report's.
    startedRecording();
    readFirstTraceReceiveTime.mockResolvedValue(at(0, "10:30:00"));

    const outcome = await recordTraceActivity("proj_a", at(0, "12:30:00"));

    expect(firstTrace(outcome)).toBe(true);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0, "10:30:00"));
    expect(events("first_trace_received")).toEqual([
      [
        "user_sam",
        "first_trace_received",
        { project_id: "proj_a", workspace_id: "ws_sam" },
        at(0, "10:30:00"),
      ],
    ]);
  });

  it("fills a project's time quietly when its report is the first the web app receives", async () => {
    startedRecording();
    readFirstTraceReceiveTime.mockResolvedValue(OCT_11);

    const outcome = await recordTraceActivity("proj_a", at(0));

    expect(firstTrace(outcome)).toBe(false);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(OCT_11);
    expect(events("first_trace_received")).toEqual([]);
    expect(db.tables.tracking).toEqual([{ id: 1, startedAt: START }]);
  });

  it("sends it for a brand-new project whose report is the first the web app receives", async () => {
    // The worker recorded its start before writing the project's first span; the
    // report reaches the web app after both.
    startedRecording();
    readFirstTraceReceiveTime.mockResolvedValue(at(0, "10:00:05"));

    const outcome = await recordTraceActivity("proj_a", at(0, "10:00:06"));

    expect(firstTrace(outcome)).toBe(true);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0, "10:00:05"));
    expect(events("first_trace_received")).toHaveLength(1);
    expect(db.tables.tracking).toEqual([{ id: 1, startedAt: START }]);
  });

  it("refuses to decide, and writes nothing, before the worker has recorded its start", async () => {
    // A report can reach a web app with no start recorded only if the start was lost;
    // taking the report's own time as the start would make this new project look old.
    db.tables.tracking.length = 0;
    readFirstTraceReceiveTime.mockResolvedValue(at(0, "11:59:58"));

    const outcome = await recordTraceActivity("proj_a", at(0));

    expect(outcome).toEqual({ kind: "tracking_not_started" });
    expect(db.tables.tracking).toEqual([]);
    expect(db.tables.projects[0].firstTraceReceiveTime).toBeNull();
    expect(db.tables.onboarding).toEqual([]);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  it("still counts the day for a project whose first trace is recorded, with no start", async () => {
    db.tables.tracking.length = 0;
    db.tables.projects[0].firstTraceReceiveTime = at(-1);

    const outcome = await recordTraceActivity("proj_a", at(0));

    expect(outcome).toMatchObject({ kind: "recorded", firstTrace: false, activeDayCounted: true });
    expect(readFirstTraceReceiveTime).not.toHaveBeenCalled();
  });

  it("records the first trace at the report's time when the store shows none yet", async () => {
    startedRecording();

    expect(firstTrace(await recordTraceActivity("proj_a", at(0)))).toBe(true);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0));
    expect(events("first_trace_received").map(([, , , timestamp]) => timestamp)).toEqual([at(0)]);
  });

  it("is looked up only while the project's time is empty", async () => {
    await recordTraceActivity("proj_a", at(0));
    await recordTraceActivity("proj_a", at(0, "13:00:00"));
    await recordTraceActivity("proj_a", at(1));

    expect(readFirstTraceReceiveTime).toHaveBeenCalledTimes(1);
  });

  it("fails the report and writes nothing about the project when the store cannot be read", async () => {
    startedRecording();
    readFirstTraceReceiveTime.mockRejectedValue(
      new Error("first-trace lookup failed with status 503"),
    );

    await expect(recordTraceActivity("proj_a", at(0))).rejects.toThrow("status 503");
    expect(db.tables.projects[0].firstTraceReceiveTime).toBeNull();
    expect(db.tables.onboarding).toEqual([]);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });
});
