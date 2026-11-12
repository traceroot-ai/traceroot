/**
 * The Loops dev seed against a real Postgres. Skipped unless TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { cleanLoops, countLoops, seedLoops } from "../dev/seed.ts";

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
      "skipped_precheck",
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
      pauseReason: "failures",
      failureStreak: 5,
    });
    expect(loops.some((l) => l.dryRun)).toBe(true);
    const memory = await db.loopMemory.findMany({ where: { projectId: ids.project } });
    expect(memory.some((m) => m.loopId === null)).toBe(true);
    expect(memory.some((m) => m.expiresAt !== null)).toBe(true);
  });

  it("--free-cap puts the workspace on Free at 30 of 30; clean takes it back", async () => {
    await seedLoops(db, ids.project, { now, freeCap: true });
    const blocked = await db.workspace.findUniqueOrThrow({ where: { id: ids.workspace } });
    expect(blocked).toMatchObject({ billingPlan: "free", loopBlocked: true });
    expect((blocked.currentUsage as { loop: { runsUsed: number } }).loop.runsUsed).toBe(30);
    await cleanLoops(db, ids.project);
    const cleared = await db.workspace.findUniqueOrThrow({ where: { id: ids.workspace } });
    expect(cleared.loopBlocked).toBe(false);
    expect(cleared.currentUsage).not.toHaveProperty("loop");
  });

  it("--complete-pending finishes the queued run", async () => {
    await seedLoops(db, ids.project, { now, completePending: true });
    expect(await db.loopRun.count({ where: { projectId: ids.project, status: "pending" } })).toBe(
      0,
    );
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
