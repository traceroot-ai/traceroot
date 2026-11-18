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

  /** Equality, null, `lt`, `gte` and `OR`: the conditions the module writes. */
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return (condition as Row[]).some((c) => matches(row, c));
      const value = row[key] ?? null;
      if (condition === null) return value === null;
      if (condition instanceof Date) {
        return value instanceof Date && value.getTime() === condition.getTime();
      }
      if (typeof condition === "object") {
        const { lt, gte } = condition as { lt?: Date; gte?: number };
        if (lt !== undefined) return value instanceof Date && value.getTime() < lt.getTime();
        if (gte !== undefined) return typeof value === "number" && value >= gte;
      }
      return value === condition;
    });
  }

  function apply(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      const increment = (value as { increment?: number } | null)?.increment;
      row[key] = increment === undefined ? value : (row[key] as number) + increment;
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
        const row = { lastActiveDay: null, activeDaysFirstWeek: 0, activeWeekAt: null, ...data };
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

import {
  ACTIVE_FIRST_WEEK_DAYS,
  recordTraceActivity,
  type TraceActivityOutcome,
} from "./trace-activity";

/** Sam signs up on 10 November; `at(n)` is noon UTC on day n of their first week. */
const SIGNED_UP = new Date("2026-11-10T09:00:00Z");
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
      ["user_sam", "first_trace_received", { project_id: "proj_a", workspace_id: "ws_sam" }],
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
      activeDaysFirstWeek: ACTIVE_FIRST_WEEK_DAYS,
      activeWeekAt: null,
    });

    const sameDay = await recordTraceActivity("proj_a", at(2, "20:00:00"));
    await recordTraceActivity("proj_a", at(3));

    expect(sameDay).toMatchObject({ activeDayCounted: false, activeFirstWeek: true });
    expect(events("active_first_week")).toHaveLength(1);
  });
});

describe("projects with traces from before recording started", () => {
  const START = at(0, "10:00:00");
  const OCT_11 = new Date("2026-10-11T08:30:00Z");
  const startedRecording = () => db.tables.tracking.push({ id: 1, startedAt: START });

  it("does not send first_trace_received for a first trace an hour before the start", async () => {
    startedRecording();
    readFirstTraceReceiveTime.mockResolvedValue(at(0, "09:00:00"));

    const outcome = await recordTraceActivity("proj_a", at(0));

    expect(firstTrace(outcome)).toBe(false);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0, "09:00:00"));
    expect(events("first_trace_received")).toEqual([]);
  });

  it("sends it for a first trace after the start, recorded at the store's receive time", async () => {
    // The report gets through two hours after the trace arrived, after retries.
    startedRecording();
    readFirstTraceReceiveTime.mockResolvedValue(at(0, "10:30:00"));

    const outcome = await recordTraceActivity("proj_a", at(0, "12:30:00"));

    expect(firstTrace(outcome)).toBe(true);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0, "10:30:00"));
    expect(events("first_trace_received")).toHaveLength(1);
  });

  it("starts recording with the first report this deployment receives", async () => {
    readFirstTraceReceiveTime.mockResolvedValue(OCT_11);

    const outcome = await recordTraceActivity("proj_a", at(0));

    expect(db.tables.tracking).toEqual([{ id: 1, startedAt: at(0) }]);
    expect(firstTrace(outcome)).toBe(false);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(OCT_11);
  });

  it("records the first trace at the report's time when the store shows none yet", async () => {
    startedRecording();

    expect(firstTrace(await recordTraceActivity("proj_a", at(0)))).toBe(true);
    expect(db.tables.projects[0].firstTraceReceiveTime).toEqual(at(0));
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
