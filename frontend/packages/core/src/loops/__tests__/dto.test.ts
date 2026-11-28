import { describe, expect, it } from "vitest";
import type { Loop, LoopRun } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { isExpired, loopToDto, runToDto } from "../queries.ts";
import { deletedLoopDetectorName, loopDetectorName, reservedDetectorProblem } from "../keys.ts";

const at = new Date("2026-11-11T10:00:00Z");

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "l1",
    projectId: "p1",
    detectorId: "d1",
    name: "Daily review",
    template: null,
    instructions: "look",
    scheduleKind: "interval",
    intervalHours: 6,
    weekday: null,
    hour: null,
    timezone: null,
    status: "active",
    dryRun: false,
    model: null,
    provider: null,
    source: null,
    lookbackHours: 24,
    nextRunAt: null,
    lastRunAt: null,
    failureStreak: 0,
    createdBy: "u1",
    createTime: at,
    updateTime: at,
    ...over,
  }) as Loop;

const run = (over: Partial<LoopRun> = {}): LoopRun =>
  ({
    id: "r1",
    loopId: "l1",
    seq: 1,
    trigger: "manual",
    slotAt: null,
    status: "pending",
    attempts: 0,
    sessionId: null,
    startedAt: null,
    finishedAt: null,
    summary: null,
    findingKeys: [],
    tracesRead: 0,
    error: null,
    metadata: null,
    costUsd: null,
    createTime: at,
    ...over,
  }) as LoopRun;

describe("a Loop's JSON shape", () => {
  it("writes dates as ISO strings and leaves unset ones null", () => {
    expect(loopToDto(loop())).toMatchObject({
      schedule: { kind: "interval", intervalHours: 6 },
      nextRunAt: null,
      lastRunAt: null,
      createTime: at.toISOString(),
    });
    expect(loopToDto(loop({ nextRunAt: at, lastRunAt: at }))).toMatchObject({
      nextRunAt: at.toISOString(),
      lastRunAt: at.toISOString(),
    });
  });
});

describe("a run's JSON shape", () => {
  it("leaves a pending run's times, metadata and cost null", () => {
    expect(runToDto(run())).toMatchObject({
      slotAt: null,
      startedAt: null,
      finishedAt: null,
      metadata: null,
      costUsd: null,
    });
  });

  it("writes a finished run's times and its cost as a number", () => {
    expect(
      runToDto(
        run({
          slotAt: at,
          startedAt: at,
          finishedAt: at,
          status: "succeeded",
          metadata: { tracesInWindow: 3 },
          costUsd: new Prisma.Decimal("0.25"),
        }),
      ),
    ).toMatchObject({
      slotAt: at.toISOString(),
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
      metadata: { tracesInWindow: 3 },
      costUsd: 0.25,
    });
  });
});

describe("a memory note's expiry", () => {
  it("never expires without a date, and expires at its date", () => {
    expect(isExpired({ expiresAt: null }, at)).toBe(false);
    expect(isExpired({ expiresAt: new Date(at.getTime() + 1) }, at)).toBe(false);
    expect(isExpired({ expiresAt: at }, at)).toBe(true);
  });
});

describe("the names a Loop's detector reserves", () => {
  it("names the detector after the Loop, and a deleted Loop's after the detector", () => {
    expect(loopDetectorName("Daily review")).toBe("loop:Daily review");
    expect(deletedLoopDetectorName("d1")).toBe("loop:deleted:d1");
  });

  it("refuses the Loop template and the loop: prefix for a user detector", () => {
    expect(reservedDetectorProblem({ template: "loop" })).toContain('template "loop"');
    expect(reservedDetectorProblem({ name: "loop:mine" })).toContain('"loop:"');
    expect(reservedDetectorProblem({ template: "tool_error", name: "mine" })).toBeNull();
    expect(reservedDetectorProblem({})).toBeNull();
  });
});
