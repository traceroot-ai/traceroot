import { describe, expect, it, vi } from "vitest";
import { runUpdateTick, isUpdateSchedulerEnabled } from "../scheduler.js";
import { updateRunJobId } from "../queue.js";

interface ScheduleRow {
  id: string;
  projectId: string;
  enabled: boolean;
  frequency: string;
  weekday: number;
  hour: number;
  timezone: string;
  nextSlotAt: Date | null;
}

/** Just enough of the database: the compare-and-set on the schedule and the unique run key. */
function fakeDb(schedules: ScheduleRow[]) {
  const runs: Array<Record<string, unknown> & { dedupeKey: string; id: string; status: string }> =
    [];
  const db = {
    projectUpdateSchedule: {
      findMany: vi.fn(async ({ where }: { where: { nextSlotAt: { lte: Date } } }) =>
        schedules
          .filter((s) => s.enabled && s.nextSlotAt !== null && s.nextSlotAt <= where.nextSlotAt.lte)
          .map((s) => ({ ...s })),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; nextSlotAt: Date | null };
          data: { nextSlotAt: Date };
        }) => {
          const row = schedules.find((s) => s.id === where.id);
          if (!row || row.nextSlotAt?.getTime() !== where.nextSlotAt?.getTime())
            return { count: 0 };
          row.nextSlotAt = data.nextSlotAt;
          return { count: 1 };
        },
      ),
    },
    projectUpdateRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> & { dedupeKey: string } }) => {
        if (runs.some((r) => r.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = {
          id: `run${runs.length + 1}`,
          status: "pending",
          createTime: new Date(0),
          ...data,
        };
        runs.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { dedupeKey: string } }) =>
          runs.find((r) => r.dedupeKey === where.dedupeKey) ?? null,
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { status: string; createTime?: { lt: Date }; startedAt?: { lt: Date } };
        }) =>
          runs.filter(
            (r) =>
              r.status === where.status &&
              (where.createTime ? (r.createTime as Date) < where.createTime.lt : true) &&
              (where.startedAt
                ? ((r.startedAt as Date) ?? new Date(0)) < where.startedAt.lt
                : true),
          ),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: string };
          data: { status: string };
        }) => {
          const run = runs.find((r) => r.id === where.id && r.status === where.status);
          if (!run) return { count: 0 };
          run.status = data.status;
          return { count: 1 };
        },
      ),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { runs, schedules, db };
}

const weeklyUtc = (overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: "s1",
  projectId: "p1",
  enabled: true,
  frequency: "weekly",
  weekday: 1,
  hour: 9,
  timezone: "UTC",
  nextSlotAt: new Date("2026-11-02T09:00:00Z"),
  ...overrides,
});

const queue = () => ({ add: vi.fn(async () => undefined) });
const AFTER_SLOT = new Date("2026-11-02T09:05:00Z");

describe("runUpdateTick", () => {
  it("starts exactly one run when the tick fires twice", async () => {
    const { db, runs } = fakeDb([weeklyUtc()]);
    const q = queue();
    await runUpdateTick(db as never, q, AFTER_SLOT);
    await runUpdateTick(db as never, q, new Date("2026-11-02T09:10:00Z"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "scheduled", projectId: "p1" });
    expect((runs[0].windowStart as Date).toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect((runs[0].windowEnd as Date).toISOString()).toBe("2026-11-02T09:00:00.000Z");
  });

  it("starts exactly one run when two workers tick at the same moment", async () => {
    const { db, runs } = fakeDb([weeklyUtc()]);
    const [a, b] = await Promise.all([
      runUpdateTick(db as never, queue(), AFTER_SLOT),
      runUpdateTick(db as never, queue(), AFTER_SLOT),
    ]);
    expect(runs).toHaveLength(1);
    expect(a.claimed + b.claimed).toBe(1);
  });

  it("still yields one run if the compare-and-set were lost, through the unique slot key", async () => {
    const { db, runs, schedules } = fakeDb([weeklyUtc()]);
    // Both workers read the row before either moved it, and both pass the set.
    db.projectUpdateSchedule.updateMany.mockImplementation(async () => {
      schedules[0].nextSlotAt = new Date("2026-11-09T09:00:00Z");
      return { count: 1 };
    });
    await Promise.all([
      runUpdateTick(db as never, queue(), AFTER_SLOT),
      runUpdateTick(db as never, queue(), AFTER_SLOT),
    ]);
    expect(runs).toHaveLength(1);
  });

  it("moves the next slot to the following week", async () => {
    const { db, schedules } = fakeDb([weeklyUtc()]);
    await runUpdateTick(db as never, queue(), AFTER_SLOT);
    expect(schedules[0].nextSlotAt!.toISOString()).toBe("2026-11-09T09:00:00.000Z");
  });

  it("ignores a schedule that is not due or is disabled", async () => {
    const { db, runs } = fakeDb([
      weeklyUtc({ nextSlotAt: new Date("2026-11-09T09:00:00Z") }),
      weeklyUtc({ id: "s2", projectId: "p2", enabled: false }),
    ]);
    await runUpdateTick(db as never, queue(), AFTER_SLOT);
    expect(runs).toHaveLength(0);
  });

  it("runs only the latest slot after the worker was down for weeks", async () => {
    const { db, runs } = fakeDb([weeklyUtc()]);
    await runUpdateTick(db as never, queue(), new Date("2026-11-25T12:00:00Z"));
    expect(runs).toHaveLength(1);
    expect((runs[0].slotAt as Date).toISOString()).toBe("2026-11-23T09:00:00.000Z");
  });

  it("uses the local calendar across a daylight-saving change", async () => {
    const { db, runs } = fakeDb([
      weeklyUtc({ timezone: "America/New_York", nextSlotAt: new Date("2026-11-02T14:00:00Z") }),
    ]);
    await runUpdateTick(db as never, queue(), new Date("2026-11-02T14:03:00Z"));
    expect((runs[0].slotAt as Date).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect((runs[0].windowStart as Date).toISOString()).toBe("2026-10-26T13:00:00.000Z");
  });

  it("queues each run under a deterministic job id", async () => {
    const { db } = fakeDb([weeklyUtc()]);
    const q = queue();
    await runUpdateTick(db as never, q, AFTER_SLOT);
    const slot = new Date("2026-11-02T09:00:00Z").getTime();
    expect((q.add.mock.calls[0] as unknown[])[2]).toMatchObject({ jobId: `update:p1:${slot}` });
  });

  it("queues again a pending run whose job was lost, under the same job id", async () => {
    const { db, runs } = fakeDb([weeklyUtc()]);
    await runUpdateTick(db as never, queue(), AFTER_SLOT);
    const q = queue();
    const result = await runUpdateTick(db as never, q, new Date("2026-11-02T09:20:00Z"));
    expect(result.recovered).toBe(1);
    const id = updateRunJobId({
      id: "x",
      projectId: "p1",
      trigger: "scheduled",
      slotAt: runs[0].slotAt as Date,
    });
    expect((q.add.mock.calls[0] as unknown[])[2]).toMatchObject({ jobId: id });
  });

  it("skips a schedule whose stored values are invalid instead of guessing", async () => {
    const { db, runs } = fakeDb([weeklyUtc({ frequency: "hourly" })]);
    await runUpdateTick(db as never, queue(), AFTER_SLOT);
    expect(runs).toHaveLength(0);
  });
});

describe("a run left running by a dead worker", () => {
  it("goes back to pending and is queued again, replacing its finished job", async () => {
    const { db, runs } = fakeDb([weeklyUtc()]);
    await runUpdateTick(db as never, queue(), AFTER_SLOT);
    runs[0].status = "running";
    runs[0].startedAt = new Date("2026-11-02T09:05:00Z");
    const remove = vi.fn(async () => undefined);
    const q = { add: vi.fn(async () => undefined), getJob: vi.fn(async () => ({ remove })) };

    const early = await runUpdateTick(db as never, q, new Date("2026-11-02T09:10:00Z"));
    expect(early.reclaimed).toBe(0);
    expect(runs[0].status).toBe("running");

    const late = await runUpdateTick(db as never, q, new Date("2026-11-02T09:30:00Z"));
    expect(late.reclaimed).toBe(1);
    expect(runs[0].status).toBe("pending");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(q.add).toHaveBeenCalled();
  });
});

describe("queue job ids", () => {
  it("uses three colon-separated parts for both kinds, as the queue requires", () => {
    const slotAt = new Date("2026-11-02T09:00:00Z");
    expect(
      updateRunJobId({ id: "r1", projectId: "p1", trigger: "scheduled", slotAt }).split(":"),
    ).toHaveLength(3);
    expect(
      updateRunJobId({ id: "r1", projectId: "p1", trigger: "manual", slotAt }).split(":"),
    ).toHaveLength(3);
  });
});

describe("isUpdateSchedulerEnabled", () => {
  it("is on by default and off for an explicit off", () => {
    expect(isUpdateSchedulerEnabled(undefined)).toBe(true);
    expect(isUpdateSchedulerEnabled("false")).toBe(false);
    expect(isUpdateSchedulerEnabled("nonsense")).toBe(false);
  });
});
