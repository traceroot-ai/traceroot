/**
 * The Loop tick's claim, reclaim, finish and findings recovery against a real
 * Postgres with the migrations applied, so their compare-and-set writes and row
 * locks race the way two replicas would. The ClickHouse writes and the signal
 * enqueue are faked. Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter traceroot-worker test db.test
 *
 * Every timestamp sits in 2000, before any other suite's rows, so a tick here
 * claims, reclaims and republishes only this file's Loops and runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@traceroot/core";
import { LOOP_LIMITS, createLoopWithDetector, createRun } from "@traceroot/core/loops";
import {
  claimDueLoops,
  enqueuePendingRuns,
  reclaimStaleRuns,
  runLoopTick,
  WORKER_STOPPED_ERROR,
} from "../scheduler.js";
import { finishLoopRun } from "../finish.js";
import {
  LOOP_FINDINGS_FAILED,
  LOOP_PUBLISH_BATCH,
  LOOP_PUBLISH_GRACE_MS,
  LOOP_PUBLISH_MAX_TRIES,
  PENDING_FINDINGS_KEY,
  pendingFindingsOf,
  republishPendingFindings,
} from "../publish.js";
import { startLoopRun } from "../start.js";

const mocks = vi.hoisted(() => ({
  writeDetectorFinding: vi.fn(),
  writeDetectorRun: vi.fn(),
  enqueueSignalHits: vi.fn(),
}));
vi.mock("../../detection/clickhouse-writer.js", () => ({
  writeDetectorFinding: mocks.writeDetectorFinding,
  writeDetectorRun: mocks.writeDetectorRun,
}));
vi.mock("../../ee/signals/queue.js", () => ({ enqueueSignalHits: mocks.enqueueSignalHits }));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  const url = process.env.TEST_DATABASE_URL;
  return url
    ? { ...actual, prisma: new actual.PrismaClient({ datasources: { db: { url } } }) }
    : actual;
});

const url = process.env.TEST_DATABASE_URL;
const suffix = Math.random().toString(36).slice(2, 8);
const ids = { workspace: `w_tick_${suffix}`, project: `p_tick_${suffix}` };

const SLOT = new Date("2000-01-01T10:00:00Z");
const NOW = new Date("2000-01-01T10:02:00Z");
const TIMEOUT_MS = 20 * 60_000;
const STARTED_LONG_AGO = new Date(NOW.getTime() - TIMEOUT_MS - 6 * 60_000);

let loopCount = 0;

/** An active hourly Loop due at `nextRunAt`. */
async function loopDueAt(nextRunAt: Date | null, status = "active", projectId = ids.project) {
  loopCount += 1;
  const loop = await prisma.$transaction((tx) =>
    createLoopWithDetector(tx, {
      projectId,
      createdBy: "u1",
      name: `tick ${loopCount}`,
      template: null,
      instructions: "look",
      schedule: { kind: "interval", intervalHours: 1 },
      dryRun: false,
      lookbackHours: 24,
      model: null,
      provider: null,
      source: null,
      now: NOW,
    }),
  );
  return prisma.loop.update({ where: { id: loop.id }, data: { nextRunAt, status } });
}

async function runOf(
  loopId: string,
  data: { status: "pending" | "running"; attempts?: number },
  projectId = ids.project,
) {
  return prisma.$transaction((tx) =>
    createRun(tx, {
      loopId,
      projectId,
      trigger: "schedule",
      status: data.status,
      data: {
        attempts: data.attempts ?? 1,
        startedAt: data.status === "running" ? STARTED_LONG_AGO : null,
      },
    }),
  );
}

/** Records every add, so a test can count how often one run was enqueued. */
function fakeQueue() {
  const added: string[] = [];
  return {
    added,
    jobs: { has: (jobId: string) => added.includes(jobId) },
    add: async (_name: string, _data: unknown, opts: { jobId?: string }) => {
      added.push(opts.jobId!);
    },
  };
}

/**
 * A succeeded run that accepted one finding and whose publish try `tries`
 * claimed it at `claimedAt`, never clearing it.
 */
async function acceptedRun(loopId: string, claimedAt: Date, tries = 1) {
  const pending = {
    ...pendingFindingsOf(
      [
        {
          key: "tool-timeouts",
          title: "Tool calls time out",
          covers: "Traces where a tool call times out.",
          summary: "Two traces hit the tool timeout.",
          traceIds: ["t1", "t2"],
        },
      ],
      claimedAt.getTime(),
    ),
    tries,
  };
  return prisma.$transaction((tx) =>
    createRun(tx, {
      loopId,
      projectId: ids.project,
      trigger: "schedule",
      status: "succeeded",
      data: {
        finishedAt: claimedAt,
        findingKeys: ["tool-timeouts"],
        metadata: { model: "m", [PENDING_FINDINGS_KEY]: pending },
      },
    }),
  );
}

async function pendingOf(runId: string) {
  const { metadata } = await prisma.loopRun.findUniqueOrThrow({ where: { id: runId } });
  return (metadata as Record<string, unknown> | null)?.[PENDING_FINDINGS_KEY] as
    | { tries: number; claimedAtMs: number }
    | undefined;
}

describe.skipIf(!url)("Loop tick on Postgres", () => {
  beforeEach(() => {
    mocks.writeDetectorFinding.mockReset().mockResolvedValue(undefined);
    mocks.writeDetectorRun.mockReset().mockResolvedValue(undefined);
    mocks.enqueueSignalHits.mockReset().mockResolvedValue(1);
  });
  beforeAll(async () => {
    await prisma.workspace.create({ data: { id: ids.workspace, name: `tick ${suffix}` } });
    await prisma.project.create({
      data: { id: ids.project, workspaceId: ids.workspace, name: "p" },
    });
  });
  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: ids.workspace } });
    await prisma.$disconnect();
  });

  describe("claimDueLoops", () => {
    it("advances a due Loop's nextRunAt and creates one scheduled run for the slot", async () => {
      const loop = await loopDueAt(SLOT);

      const created = await claimDueLoops(NOW);

      const runs = await prisma.loopRun.findMany({ where: { loopId: loop.id } });
      expect(runs).toHaveLength(1);
      expect(created).toContain(runs[0]!.id);
      expect(runs[0]).toMatchObject({
        trigger: "schedule",
        status: "pending",
        seq: 1,
        slotAt: SLOT,
      });
      // An interval counts from the claimed slot, not from the tick's lateness.
      const after = await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } });
      expect(after.nextRunAt).toEqual(new Date("2000-01-01T11:00:00Z"));
    });

    it("creates one run per slot when several ticks claim at once", async () => {
      const loop = await loopDueAt(SLOT);

      await Promise.all(Array.from({ length: 5 }, () => claimDueLoops(NOW)));

      expect(await prisma.loopRun.count({ where: { loopId: loop.id } })).toBe(1);
      const after = await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } });
      expect(after.nextRunAt).toEqual(new Date("2000-01-01T11:00:00Z"));
    });

    it("runs only the latest slot after missing several, counting the next from now", async () => {
      const loop = await loopDueAt(new Date("2000-01-01T05:00:00Z"));

      await claimDueLoops(NOW);

      expect(await prisma.loopRun.count({ where: { loopId: loop.id } })).toBe(1);
      const after = await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } });
      expect(after.nextRunAt).toEqual(new Date("2000-01-01T11:02:00Z"));
    });

    it("advances the slot without a second run while the Loop has one going", async () => {
      const loop = await loopDueAt(SLOT);
      await runOf(loop.id, { status: "running" });

      await claimDueLoops(NOW);

      expect(await prisma.loopRun.count({ where: { loopId: loop.id } })).toBe(1);
      const after = await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } });
      expect(after.nextRunAt).toEqual(new Date("2000-01-01T11:00:00Z"));
    });

    it("leaves paused and not-yet-due Loops alone", async () => {
      const paused = await loopDueAt(SLOT, "paused");
      const later = await loopDueAt(new Date("2000-01-01T12:00:00Z"));

      await claimDueLoops(NOW);

      expect(await prisma.loopRun.count({ where: { loopId: { in: [paused.id, later.id] } } })).toBe(
        0,
      );
    });
  });

  describe("reclaimStaleRuns", () => {
    it("puts a dead worker's run back to pending once, then fails it", async () => {
      const loop = await loopDueAt(null);
      const run = await runOf(loop.id, { status: "running" });
      const queue = fakeQueue();

      await reclaimStaleRuns(NOW, queue, TIMEOUT_MS);
      expect(await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "pending",
        attempts: 2,
        startedAt: null,
      });
      expect(queue.jobs.has(`loop-run-${run.id}`)).toBe(true);

      // The retry was picked up and its worker died too.
      await prisma.loopRun.update({
        where: { id: run.id },
        data: { status: "running", startedAt: STARTED_LONG_AGO },
      });
      await reclaimStaleRuns(NOW, queue, TIMEOUT_MS);
      const failed = await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(failed).toMatchObject({ status: "failed", error: WORKER_STOPPED_ERROR });
      expect(failed.finishedAt).toEqual(NOW);
      expect(await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } })).toMatchObject({
        failureStreak: 1,
        lastRunAt: NOW,
      });
    });

    it("retries a stale run once when several ticks reclaim it at once", async () => {
      const loop = await loopDueAt(null);
      const run = await runOf(loop.id, { status: "running" });
      const queue = fakeQueue();

      await Promise.all(Array.from({ length: 5 }, () => reclaimStaleRuns(NOW, queue, TIMEOUT_MS)));

      expect(await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "pending",
        attempts: 2,
      });
      // One tick won the reset; the others saw it already done.
      expect(queue.added.filter((id) => id === `loop-run-${run.id}`)).toHaveLength(1);
    });

    it("fails a stale last attempt once when several ticks reclaim it at once", async () => {
      const loop = await loopDueAt(null);
      await runOf(loop.id, { status: "running", attempts: 2 });

      await Promise.all(
        Array.from({ length: 5 }, () => reclaimStaleRuns(NOW, fakeQueue(), TIMEOUT_MS)),
      );

      expect(await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } })).toMatchObject({
        failureStreak: 1,
      });
    });

    it("leaves a run still inside its timeout and grace alone", async () => {
      const loop = await loopDueAt(null);
      const run = await runOf(loop.id, { status: "running" });
      await prisma.loopRun.update({
        where: { id: run.id },
        data: { startedAt: new Date(NOW.getTime() - TIMEOUT_MS - 4 * 60_000) },
      });

      await reclaimStaleRuns(NOW, fakeQueue(), TIMEOUT_MS);

      expect((await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "running",
      );
    });
  });

  describe("finishLoopRun", () => {
    it("lands once when a reclaim and a late worker finish the same run", async () => {
      const loop = await loopDueAt(null);
      const run = await runOf(loop.id, { status: "running" });
      const target = { ...run, fromStatus: "running" as const };

      const results = await Promise.all([
        finishLoopRun(target, { status: "failed", error: WORKER_STOPPED_ERROR }, NOW),
        finishLoopRun(target, { status: "quiet", summary: "done" }, NOW),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      const finished = await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } });
      const streak = (await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } }))
        .failureStreak;
      // Whichever won, the Loop was settled once, by that outcome.
      expect(streak).toBe(finished.status === "failed" ? 1 : 0);
    });

    it("does not let a first try that outlived its reclaim finish the retry", async () => {
      const loop = await loopDueAt(null);
      const run = await runOf(loop.id, { status: "running" });
      // The first try's worker took the run as it was before the reclaim.
      const firstTry = { ...run, fromStatus: "running" as const };

      await reclaimStaleRuns(NOW, fakeQueue(), TIMEOUT_MS);
      // The retry was picked up and is running now.
      await prisma.loopRun.update({
        where: { id: run.id },
        data: { status: "running", startedAt: NOW },
      });
      const retry = await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(retry.attempts).toBe(firstTry.attempts + 1);

      expect(await finishLoopRun(firstTry, { status: "quiet", summary: "late" }, NOW)).toBe(false);
      expect(await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "running",
        summary: null,
        finishedAt: null,
      });
      expect(
        (await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } })).lastRunAt,
      ).toBeNull();

      const retryTarget = { ...retry, fromStatus: "running" as const };
      expect(await finishLoopRun(retryTarget, { status: "quiet", summary: "done" }, NOW)).toBe(
        true,
      );
      expect(await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "quiet",
        summary: "done",
      });
    });
  });

  describe("republishPendingFindings", () => {
    const PAST_GRACE = new Date(NOW.getTime() - LOOP_PUBLISH_GRACE_MS - 60_000);

    it("republishes findings left pending past the grace period, then clears them", async () => {
      const loop = await loopDueAt(null);
      const run = await acceptedRun(loop.id, PAST_GRACE);

      const counts = await republishPendingFindings(NOW);

      expect(counts).toMatchObject({ published: 1, retry: 0, gave_up: 0 });
      expect(mocks.writeDetectorFinding).toHaveBeenCalledTimes(2);
      expect(mocks.writeDetectorRun).toHaveBeenCalledTimes(2);
      // The hits keep the time the run accepted them.
      for (const [row] of mocks.writeDetectorRun.mock.calls) {
        expect(row).toMatchObject({
          detectorId: loop.detectorId,
          timestampMs: PAST_GRACE.getTime(),
        });
      }
      expect(mocks.enqueueSignalHits).toHaveBeenCalledTimes(1);
      const row = await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row).toMatchObject({ status: "succeeded", error: null, metadata: { model: "m" } });
      expect(await pendingOf(run.id)).toBeUndefined();
    });

    it("leaves runs without findings to publish, and claims inside the grace period, alone", async () => {
      const loop = await loopDueAt(null);
      const fresh = await acceptedRun(loop.id, new Date(NOW.getTime() - 60_000));
      const done = await prisma.$transaction((tx) =>
        createRun(tx, {
          loopId: loop.id,
          projectId: ids.project,
          trigger: "schedule",
          status: "succeeded",
          data: { finishedAt: PAST_GRACE, findingKeys: ["a"], metadata: { model: "m" } },
        }),
      );

      await republishPendingFindings(NOW);

      expect(mocks.writeDetectorFinding).not.toHaveBeenCalled();
      expect(mocks.enqueueSignalHits).not.toHaveBeenCalled();
      expect(await pendingOf(fresh.id)).toMatchObject({ tries: 1 });
      expect(await prisma.loopRun.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({
        metadata: { model: "m" },
        error: null,
      });
      // Out of the way of the later ticks below.
      await prisma.loopRun.delete({ where: { id: fresh.id } });
    });

    it("keeps the findings pending, as the next try, when the writes fail again", async () => {
      const loop = await loopDueAt(null);
      const run = await acceptedRun(loop.id, PAST_GRACE);
      mocks.writeDetectorFinding.mockRejectedValue(new Error("Backend API error 503"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await republishPendingFindings(NOW)).toMatchObject({ retry: 1 });
      // Claimed now, so the next tick inside the grace period leaves it alone.
      expect(await pendingOf(run.id)).toEqual(
        expect.objectContaining({ tries: 2, claimedAtMs: NOW.getTime() }),
      );
      mocks.writeDetectorFinding.mockReset().mockResolvedValue(undefined);
      expect(await republishPendingFindings(NOW)).toMatchObject({ published: 0, retry: 0 });

      const later = new Date(NOW.getTime() + LOOP_PUBLISH_GRACE_MS + 1);
      expect(await republishPendingFindings(later)).toMatchObject({ published: 1 });
      expect(await pendingOf(run.id)).toBeUndefined();
      vi.mocked(console.error).mockRestore();
    });

    it("gives up on a run that used every publish try, keeping it succeeded", async () => {
      const loop = await loopDueAt(null);
      const run = await acceptedRun(loop.id, PAST_GRACE, LOOP_PUBLISH_MAX_TRIES);
      vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await republishPendingFindings(NOW)).toMatchObject({ gave_up: 1 });

      expect(mocks.writeDetectorFinding).not.toHaveBeenCalled();
      expect(await prisma.loopRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "succeeded",
        error: LOOP_FINDINGS_FAILED,
        findingKeys: ["tool-timeouts"],
      });
      expect(await pendingOf(run.id)).toBeUndefined();
      vi.mocked(console.error).mockRestore();
    });

    it("publishes each run once when several ticks republish at once", async () => {
      const loop = await loopDueAt(null);
      const run = await acceptedRun(loop.id, PAST_GRACE);

      await Promise.all(Array.from({ length: 4 }, () => republishPendingFindings(NOW)));

      expect(mocks.writeDetectorRun).toHaveBeenCalledTimes(2);
      expect(mocks.enqueueSignalHits).toHaveBeenCalledTimes(1);
      expect(await pendingOf(run.id)).toBeUndefined();
    });

    it("republishes at most a batch of runs per tick, oldest claim first", async () => {
      const loop = await loopDueAt(null);
      const runs = [];
      for (let i = 0; i <= LOOP_PUBLISH_BATCH; i++) {
        runs.push(await acceptedRun(loop.id, new Date(PAST_GRACE.getTime() - i * 1_000)));
      }

      expect(await republishPendingFindings(NOW)).toMatchObject({
        published: LOOP_PUBLISH_BATCH,
      });
      // The newest claim waits for the next tick.
      expect(await pendingOf(runs[0]!.id)).toMatchObject({ tries: 1 });
      for (const run of runs.slice(1)) expect(await pendingOf(run.id)).toBeUndefined();

      expect(await republishPendingFindings(NOW)).toMatchObject({ published: 1 });
      expect(await pendingOf(runs[0]!.id)).toBeUndefined();
    });
  });

  describe("enqueue", () => {
    it("enqueues a pending run under its deterministic job id", async () => {
      const loop = await loopDueAt(null);
      const run = await runOf(loop.id, { status: "pending" });
      const queue = fakeQueue();

      await enqueuePendingRuns(queue);

      expect(queue.added.filter((id) => id === `loop-run-${run.id}`)).toHaveLength(1);
    });

    it("claims a due Loop and enqueues its new run in the same tick", async () => {
      const loop = await loopDueAt(SLOT);
      const queue = fakeQueue();

      await runLoopTick(NOW, queue);

      const run = await prisma.loopRun.findFirstOrThrow({ where: { loopId: loop.id } });
      expect(queue.jobs.has(`loop-run-${run.id}`)).toBe(true);
    });
  });

  describe("startLoopRun", () => {
    it("starts only one of two Loops' runs racing for the project's last daily run", async () => {
      // A project of its own, so no other test's runs count toward its cap.
      const projectId = `p_cap_${suffix}`;
      await prisma.project.create({
        data: { id: projectId, workspaceId: ids.workspace, name: "cap" },
      });
      const filler = await loopDueAt(null, "active", projectId);
      // Running runs count before they have a session: 23 of 24 used.
      for (let i = 0; i < LOOP_LIMITS.runsPerProjectPerDay - 1; i++) {
        await runOf(filler.id, { status: "running" }, projectId);
      }
      const first = await runOf(
        (await loopDueAt(null, "active", projectId)).id,
        {
          status: "pending",
        },
        projectId,
      );
      const second = await runOf(
        (await loopDueAt(null, "active", projectId)).id,
        {
          status: "pending",
        },
        projectId,
      );

      const outcomes = await Promise.all([startLoopRun(first), startLoopRun(second)]);

      expect(outcomes.sort()).toEqual(["skipped", "started"]);
      const runs = await prisma.loopRun.findMany({
        where: { id: { in: [first.id, second.id] } },
        select: { status: true },
      });
      expect(runs.map((r) => r.status).sort()).toEqual(["running", "skipped_blocked"]);
    });
  });
});
