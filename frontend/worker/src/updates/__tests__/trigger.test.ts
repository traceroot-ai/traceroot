import { describe, expect, it, vi } from "vitest";
import { frozenClock } from "@traceroot/core/updates";
import { insertRun, scheduledDedupeKey } from "../runs.js";
import { assertManualTriggerAllowed, triggerManualRun } from "../trigger.js";

const NOW = "2026-11-02T09:30:00Z";

/** An in-memory stand-in with the one behaviour that matters: a unique dedupeKey. */
function fakeDb(schedule: Record<string, unknown> | null = null) {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    db: {
      project: { findFirst: vi.fn(async () => ({ id: "p1" })) },
      projectUpdateSchedule: { findUnique: vi.fn(async () => schedule) },
      projectUpdateRun: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (rows.some((r) => r.dedupeKey === data.dedupeKey)) {
            throw Object.assign(new Error("unique"), { code: "P2002" });
          }
          const row = { id: `run${rows.length + 1}`, status: "pending", ...data };
          rows.push(row);
          return row;
        }),
        findUnique: vi.fn(
          async ({ where }: { where: { dedupeKey: string } }) =>
            rows.find((r) => r.dedupeKey === where.dedupeKey) ?? null,
        ),
      },
    },
  };
}

describe("triggerManualRun", () => {
  it("gives identical window boundaries for the same frozen now, on repeated triggers", async () => {
    const { db } = fakeDb();
    const clock = frozenClock(NOW);
    const first = await triggerManualRun(db as never, { projectId: "p1", clock, env: {} });
    const second = await triggerManualRun(db as never, { projectId: "p1", clock, env: {} });
    expect(second.run.id).not.toBe(first.run.id);
    for (const key of ["slotAt", "windowStart", "windowEnd", "prevWindowStart", "prevWindowEnd"]) {
      expect((second.run as never)[key]).toEqual((first.run as never)[key]);
    }
    expect((first.run.windowStart as Date).toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect((first.run.windowEnd as Date).toISOString()).toBe("2026-11-02T09:00:00.000Z");
  });

  it("uses the project's own schedule and timezone", async () => {
    const { db } = fakeDb({
      enabled: true,
      frequency: "daily",
      weekday: 1,
      hour: 8,
      timezone: "America/New_York",
    });
    const { run } = await triggerManualRun(db as never, {
      projectId: "p1",
      clock: frozenClock(NOW),
      env: {},
    });
    expect((run.windowEnd as Date).toISOString()).toBe("2026-11-01T13:00:00.000Z"); // 08:00 EST
    expect((run.windowStart as Date).toISOString()).toBe("2026-10-31T12:00:00.000Z"); // 08:00 EDT: a 25 hour day
  });

  it("is refused in production unless allowed", async () => {
    expect(() => assertManualTriggerAllowed({ NODE_ENV: "production" })).toThrow(/development/);
    expect(() =>
      assertManualTriggerAllowed({ NODE_ENV: "production", TRACEROOT_UPDATES_ALLOW_MANUAL: "1" }),
    ).not.toThrow();
    expect(() => assertManualTriggerAllowed({ NODE_ENV: "development" })).not.toThrow();
  });
});

describe("insertRun", () => {
  it("returns the existing run when the same slot is claimed twice", async () => {
    const { db, rows } = fakeDb();
    const windows = {
      slotAt: new Date("2026-11-02T09:00:00Z"),
      windowStart: new Date("2026-10-26T09:00:00Z"),
      windowEnd: new Date("2026-11-02T09:00:00Z"),
      prevWindowStart: new Date("2026-10-19T09:00:00Z"),
      prevWindowEnd: new Date("2026-10-26T09:00:00Z"),
    };
    const input = {
      projectId: "p1",
      trigger: "scheduled" as const,
      windows,
      schedule: { frequency: "weekly" as const, timezone: "UTC" },
    };
    const a = await insertRun(db as never, input);
    const b = await insertRun(db as never, input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(scheduledDedupeKey("p1", windows.slotAt));
  });
});
