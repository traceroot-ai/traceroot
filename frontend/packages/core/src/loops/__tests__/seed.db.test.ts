/**
 * The Loops dev seed against a real Postgres. Skipped unless TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { cleanLoops, countLoops, seedLoops } from "../dev/seed.ts";
import { findingKeyOfGroupKey } from "../keys.ts";
import { createLoopWithDetector, deleteLoopKeepingDetector } from "../writes.ts";
import { listLoopRuns } from "../queries.ts";
import { getLoopTemplate } from "../templates.ts";

const url = process.env.TEST_DATABASE_URL;
const suffix = Math.random().toString(36).slice(2, 8);
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as never);
const ids = { workspace: `w_seed_${suffix}`, project: `p_seed_${suffix}` };
const now = new Date("2026-11-11T12:00:00Z");

const projectRows = async () => ({
  loops: await db.loop.count({ where: { projectId: ids.project } }),
  detectors: await db.detector.count({ where: { projectId: ids.project } }),
  runs: await db.loopRun.count({ where: { projectId: ids.project } }),
  signals: await db.signal.count({ where: { projectId: ids.project } }),
  memories: await db.loopMemory.count({ where: { projectId: ids.project } }),
  sessions: await db.aISession.count({ where: { projectId: ids.project } }),
});

describe.skipIf(!url)("Loops seed", () => {
  beforeAll(async () => {
    await db.workspace.create({
      data: { id: ids.workspace, name: `seed ${suffix}`, billingPlan: "starter" },
    });
    await db.project.create({ data: { id: ids.project, workspaceId: ids.workspace, name: "p" } });
  });
  afterAll(async () => {
    await db.workspace.delete({ where: { id: ids.workspace } });
    await db.$disconnect();
  });

  it("seed -> clean -> seed gives identical counts, and clean leaves nothing behind", async () => {
    const first = await seedLoops(db, ids.project, { now });
    expect(first).toMatchObject({ loops: 5, detectors: 5, memories: 3 });
    const rows = await projectRows();

    await cleanLoops(db, ids.project);
    expect(await countLoops(db, ids.project)).toEqual({
      loops: 0,
      detectors: 0,
      runs: 0,
      signals: 0,
      signalHits: 0,
      memories: 0,
      sessions: 0,
      messages: 0,
    });
    expect(await projectRows()).toEqual({
      loops: 0,
      detectors: 0,
      runs: 0,
      signals: 0,
      memories: 0,
      sessions: 0,
    });

    expect(await seedLoops(db, ids.project, { now })).toEqual(first);
    expect(await projectRows()).toEqual(rows);
    // A second seed without a clean in between replaces rather than doubles.
    expect(await seedLoops(db, ids.project, { now })).toEqual(first);
  });

  it("covers every run outcome and every Loop state the screens show", async () => {
    const statuses = await db.loopRun.groupBy({
      by: ["status"],
      where: { projectId: ids.project },
      _count: true,
    });
    expect(statuses.map((s) => s.status).sort()).toEqual([
      "failed",
      "pending",
      "quiet",
      "running",
      "skipped_blocked",
      "succeeded",
      "timed_out",
    ]);
    const loops = await db.loop.findMany({ where: { projectId: ids.project } });
    expect(loops.map((l) => l.status).sort()).toEqual([
      "active",
      "active",
      "active",
      "paused",
      "paused_by_system",
    ]);
    expect(loops.find((l) => l.status === "paused_by_system")).toMatchObject({
      failureStreak: 5,
    });
    expect(loops.some((l) => l.dryRun)).toBe(true);
    const memory = await db.loopMemory.findMany({ where: { projectId: ids.project } });
    expect(memory.some((m) => m.loopId === null)).toBe(true);
    expect(memory.some((m) => m.expiresAt !== null)).toBe(true);
  });

  it("records every seeded finding in at least one of its Loop's runs, some in several", async () => {
    const loops = await db.loop.findMany({
      where: { projectId: ids.project },
      select: { id: true, detectorId: true },
    });
    const signals = await db.signal.findMany({
      where: { projectId: ids.project, detectorId: { in: loops.map((l) => l.detectorId) } },
      select: { id: true, detectorId: true, groupKey: true },
    });
    expect(signals.length).toBeGreaterThan(0);
    const runCounts: number[] = [];
    for (const signal of signals) {
      const key = findingKeyOfGroupKey(signal.groupKey);
      expect(key, `group key ${signal.groupKey}`).not.toBeNull();
      const loop = loops.find((l) => l.detectorId === signal.detectorId)!;
      const runs = await db.loopRun.findMany({
        where: { loopId: loop.id },
        select: { findingKeys: true },
      });
      const recording = runs.filter((r) => r.findingKeys.includes(key!)).length;
      expect(recording, `runs recording ${key}`).toBeGreaterThan(0);
      // The query the signal panel's "Seen in N runs" reads agrees.
      const listed = await listLoopRuns(db, {
        projectId: ids.project,
        loop,
        page: 0,
        limit: 1,
        signalId: signal.id,
      });
      expect(listed.meta.total).toBe(recording);
      runCounts.push(recording);
    }
    expect(Math.max(...runCounts)).toBeGreaterThan(1);
  });

  it("gives every Loop instructions, a templated one its template's prompt", async () => {
    const loops = await db.loop.findMany({ where: { projectId: ids.project } });
    for (const loop of loops) expect(loop.instructions.trim(), loop.name).not.toBe("");
    const templated = loops.filter((l) => l.template !== null);
    expect(templated.length).toBeGreaterThan(0);
    for (const loop of templated) {
      expect(loop.instructions).toBe(getLoopTemplate(loop.template)!.defaultInstructions);
    }
  });

  it("dates each hit by a run that recorded its finding, so a time window counts it", async () => {
    const loops = await db.loop.findMany({
      where: { projectId: ids.project },
      select: { id: true, detectorId: true, lookbackHours: true },
    });
    const signals = await db.signal.findMany({
      where: { projectId: ids.project, detectorId: { in: loops.map((l) => l.detectorId) } },
      select: { id: true, detectorId: true, groupKey: true, firstSeenAt: true, lastSeenAt: true },
    });
    for (const signal of signals) {
      const key = findingKeyOfGroupKey(signal.groupKey)!;
      const loop = loops.find((l) => l.detectorId === signal.detectorId)!;
      const runs = await db.loopRun.findMany({
        where: { loopId: loop.id, findingKeys: { has: key } },
        select: { startedAt: true, finishedAt: true },
      });
      const hits = await db.signalHit.findMany({
        where: { signalId: signal.id },
        select: { seenAt: true, traceStartTime: true },
      });
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        // Seen when one of the recording runs finished, its trace inside that run's look-back.
        const run = runs.find((r) => r.finishedAt!.getTime() === hit.seenAt.getTime());
        expect(run, `a run of ${key} finishing at ${hit.seenAt.toISOString()}`).toBeDefined();
        expect(hit.traceStartTime).not.toBeNull();
        const start = hit.traceStartTime!.getTime();
        expect(start).toBeLessThan(run!.startedAt!.getTime());
        expect(start).toBeGreaterThanOrEqual(
          run!.startedAt!.getTime() - loop.lookbackHours * 3_600_000,
        );
      }
      const seen = hits.map((h) => h.seenAt.getTime());
      expect(signal.firstSeenAt.getTime()).toBe(Math.min(...seen));
      expect(signal.lastSeenAt.getTime()).toBe(Math.max(...seen));
    }
    // The signal list's window (traces starting in the last 7 days) counts every seeded hit.
    const inWeek = await db.signalHit.count({
      where: {
        signalId: { in: signals.map((s) => s.id) },
        traceStartTime: { gte: new Date(now.getTime() - 7 * 24 * 3_600_000), lt: now },
      },
    });
    expect(inWeek).toBe(await db.signalHit.count({ where: { projectId: ids.project } }));
  });

  it("--free-cap puts the workspace on Free at 30 of 30; clean takes it back", async () => {
    // The workspace starts on Starter (beforeAll), so a clean that left it on Free fails here.
    await seedLoops(db, ids.project, { now, freeCap: true });
    // Seeding again cleans first: the plan it keeps is still Starter, not the Free it set.
    await seedLoops(db, ids.project, { now, freeCap: true });
    const blocked = await db.workspace.findUniqueOrThrow({ where: { id: ids.workspace } });
    expect(blocked).toMatchObject({ billingPlan: "free", loopBlocked: true });
    expect((blocked.currentUsage as { loop: { runsUsed: number } }).loop.runsUsed).toBe(30);
    await cleanLoops(db, ids.project);
    const cleared = await db.workspace.findUniqueOrThrow({ where: { id: ids.workspace } });
    expect(cleared).toMatchObject({ billingPlan: "starter", loopBlocked: false });
    expect(cleared.currentUsage).not.toHaveProperty("loop");
  });

  it("clean leaves a Loop meter and block the seed did not set", async () => {
    const meter = { runsUsed: 30, systemTokenCost: 0, systemInputTokens: 0, systemOutputTokens: 0 };
    await db.workspace.update({
      where: { id: ids.workspace },
      data: { billingPlan: "free", loopBlocked: true, currentUsage: { loop: meter } },
    });
    await cleanLoops(db, ids.project);
    const after = await db.workspace.findUniqueOrThrow({ where: { id: ids.workspace } });
    expect(after).toMatchObject({ billingPlan: "free", loopBlocked: true });
    expect(after.currentUsage).toEqual({ loop: meter });
    await db.workspace.update({
      where: { id: ids.workspace },
      data: { billingPlan: "starter", loopBlocked: false, currentUsage: {} },
    });
  });

  it("--complete-pending finishes the queued run", async () => {
    await seedLoops(db, ids.project, { now, completePending: true });
    expect(await db.loopRun.count({ where: { projectId: ids.project, status: "pending" } })).toBe(
      0,
    );
  });

  it("clean removes what a seeded Loop deleted since left behind, and no other Loop's", async () => {
    await seedLoops(db, ids.project, { now });
    // A seeded Loop deleted in the UI: its detector and signals stay.
    const deleted = await db.loop.findFirstOrThrow({
      where: { projectId: ids.project, name: "Coding agents" },
      select: { id: true, detectorId: true },
    });
    await db.$transaction((tx) => deleteLoopKeepingDetector(tx, deleted));
    const left = { projectId: ids.project, detectorId: deleted.detectorId };
    expect(await db.signal.count({ where: left })).toBeGreaterThan(0);
    expect(await db.detector.count({ where: { id: deleted.detectorId } })).toBe(1);
    // A real Loop, deleted with a signal (no seed hits) left behind: both must survive the clean.
    const realLoop = await db.$transaction((tx) =>
      createLoopWithDetector(tx, {
        projectId: ids.project,
        createdBy: "u1",
        name: "real",
        template: null,
        instructions: "look",
        schedule: { kind: "interval", intervalHours: 6 },
        dryRun: false,
        lookbackHours: 24,
        model: null,
        provider: null,
        source: null,
        now,
      }),
    );
    const real = await db.signal.create({
      data: {
        projectId: ids.project,
        detectorId: realLoop.detectorId,
        title: "real",
        criteriaCovers: "c",
        criteriaExcludes: "",
        anchorText: "real",
        groupKey: "loop:real",
        status: "open",
        hitCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        hits: {
          create: {
            runId: `real-run-${suffix}`,
            projectId: ids.project,
            detectorId: realLoop.detectorId,
            traceId: "t-real",
            findingId: "f-real",
            seenAt: now,
            traceStartTime: now,
            assignedAt: now,
            copyPending: false,
          },
        },
      },
    });
    await db.$transaction((tx) => deleteLoopKeepingDetector(tx, realLoop));

    await cleanLoops(db, ids.project);
    expect(await db.signal.count({ where: left })).toBe(0);
    expect(await db.signalHit.count({ where: left })).toBe(0);
    expect(await db.detector.count({ where: { id: deleted.detectorId } })).toBe(0);
    expect(
      await db.signal.findMany({ where: { projectId: ids.project }, select: { id: true } }),
    ).toEqual([{ id: real.id }]);
    expect(await db.detector.count({ where: { id: realLoop.detectorId } })).toBe(1);
    await db.signal.delete({ where: { id: real.id } });
    await db.detector.delete({ where: { id: realLoop.detectorId } });
  });

  it("clean keeps a note a Loop wrote under a key the seed also uses", async () => {
    await seedLoops(db, ids.project, { now });
    const loop = await db.loop.findFirstOrThrow({ where: { projectId: ids.project } });
    const run = await db.loopRun.findFirstOrThrow({ where: { loopId: loop.id } });
    await db.loopMemory.update({
      where: { projectId_key: { projectId: ids.project, key: "known-flaky-tests" } },
      data: { loopId: loop.id, updatedByRunId: run.id, content: "rewritten by a run" },
    });
    await db.loopMemory.create({
      data: { projectId: ids.project, key: "own-note", content: "mine" },
    });

    await cleanLoops(db, ids.project);

    const left = await db.loopMemory.findMany({
      where: { projectId: ids.project },
      select: { key: true, content: true },
      orderBy: { key: "asc" },
    });
    expect(left).toEqual([
      { key: "known-flaky-tests", content: "rewritten by a run" },
      { key: "own-note", content: "mine" },
    ]);
    await db.loopMemory.deleteMany({ where: { projectId: ids.project } });
  });

  it("leaves the project's own data alone", async () => {
    const own = await db.detector.create({
      data: {
        projectId: ids.project,
        name: "mine",
        template: "failure",
        prompt: "p",
        outputSchema: [],
      },
    });
    await seedLoops(db, ids.project, { now });
    await cleanLoops(db, ids.project);
    expect(await db.detector.count({ where: { id: own.id } })).toBe(1);
  });
});
