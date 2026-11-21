/**
 * Runs the Loop data layer against a real Postgres with the migrations applied.
 * Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter @traceroot/core test loops.db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { LOOP_DETECTOR_TEMPLATE } from "../keys.ts";
import {
  createLoopWithDetector,
  createRun,
  deleteLoopKeepingDetector,
  hasActiveRun,
  lockLoop,
  projectAtLoopCap,
  upsertMemory,
} from "../writes.ts";
import { getLoopSummary, listLoops, listMemory } from "../queries.ts";
import { COUNTED_RUN_STATUSES, LOOP_LIMITS } from "../contracts.ts";
import { listSignals } from "../../ee/signals/reads.ts";

const url = process.env.TEST_DATABASE_URL;
const suffix = Math.random().toString(36).slice(2, 8);
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as never);
const ids = { workspace: `w_loops_${suffix}`, project: `p_loops_${suffix}` };

const newLoop = (name: string) => ({
  projectId: ids.project,
  createdBy: "u1",
  name,
  template: null,
  instructions: "look",
  schedule: { kind: "interval" as const, intervalHours: 6 },
  dryRun: false,
  lookbackHours: 24,
  model: null,
  provider: null,
  source: null,
  now: new Date("2026-11-11T00:00:00Z"),
});

describe.skipIf(!url)("Loops on Postgres", () => {
  beforeAll(async () => {
    await db.workspace.create({ data: { id: ids.workspace, name: `loops ${suffix}` } });
    await db.project.create({ data: { id: ids.project, workspaceId: ids.workspace, name: "p" } });
  });
  afterAll(async () => {
    await db.workspace.delete({ where: { id: ids.workspace } });
    await db.$disconnect();
  });

  it("creates the Loop with its hidden detector in one call; deleting it keeps the detector", async () => {
    const loop = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("alpha")));
    const detector = await db.detector.findUniqueOrThrow({ where: { id: loop.detectorId } });
    expect(detector).toMatchObject({
      template: LOOP_DETECTOR_TEMPLATE,
      name: "loop:alpha",
      enabled: false,
      enableRca: false,
      enableSignals: true,
    });
    expect(loop.nextRunAt?.toISOString()).toBe("2026-11-11T06:00:00.000Z");

    await db.$transaction((tx) => deleteLoopKeepingDetector(tx, loop));
    expect(await db.loop.count({ where: { id: loop.id } })).toBe(0);
    expect(await db.detector.findUniqueOrThrow({ where: { id: loop.detectorId } })).toMatchObject({
      template: LOOP_DETECTOR_TEMPLATE,
      name: `loop:deleted:${loop.detectorId}`,
    });
    // The name is free again.
    const again = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("alpha")));
    await db.$transaction((tx) => deleteLoopKeepingDetector(tx, again));
  });

  it("reads a deleted Loop's signals as found by a deleted Loop", async () => {
    const loop = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("epsilon")));
    const at = new Date("2026-11-11T00:00:00Z");
    await db.signal.create({
      data: {
        projectId: ids.project,
        detectorId: loop.detectorId,
        title: "found",
        criteriaCovers: "c",
        criteriaExcludes: "",
        anchorText: "found",
        groupKey: "loop:found",
        status: "open",
        hitCount: 0,
        firstSeenAt: at,
        lastSeenAt: at,
      },
    });
    const sourceOfFound = async () => {
      const { signals } = await listSignals(db, { projectId: ids.project, page: 0, limit: 50 });
      const s = signals.find((x) => x.title === "found")!;
      return { detectorName: s.detectorName, source: s.source };
    };
    expect(await sourceOfFound()).toEqual({
      detectorName: null,
      source: { kind: "loop", id: loop.id, name: "epsilon", detectorId: loop.detectorId },
    });
    await db.$transaction((tx) => deleteLoopKeepingDetector(tx, loop));
    expect(await sourceOfFound()).toEqual({
      detectorName: null,
      source: { kind: "deletedLoop", detectorId: loop.detectorId },
    });
  });

  it("lets concurrent creates in one project stop at the Loop cap", async () => {
    const project = `${ids.project}_cap`;
    await db.project.create({ data: { id: project, workspaceId: ids.workspace, name: "cap" } });
    const created = await Promise.all(
      Array.from({ length: LOOP_LIMITS.loopsPerProject + 3 }, (_, i) =>
        db.$transaction(async (tx) => {
          if (await projectAtLoopCap(tx, project)) return null;
          return createLoopWithDetector(tx, { ...newLoop(`cap-${i}`), projectId: project });
        }),
      ),
    );
    expect(created.filter(Boolean)).toHaveLength(LOOP_LIMITS.loopsPerProject);
    expect(await db.loop.count({ where: { projectId: project } })).toBe(
      LOOP_LIMITS.loopsPerProject,
    );
  });

  it("lets concurrent Run nows on one Loop insert one run", async () => {
    const loop = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("zeta")));
    await Promise.all(
      Array.from({ length: 6 }, () =>
        db.$transaction(async (tx) => {
          const locked = await lockLoop(tx, ids.project, loop.id);
          if (!locked || (await hasActiveRun(tx, loop.id))) return null;
          return createRun(tx, { loopId: loop.id, projectId: ids.project, trigger: "manual" });
        }),
      ),
    );
    expect(await db.loopRun.count({ where: { loopId: loop.id } })).toBe(1);
    expect(await db.$transaction((tx) => lockLoop(tx, "another-project", loop.id))).toBeNull();
  });

  it("gives concurrent run creates distinct, gapless sequence numbers", async () => {
    const loop = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("beta")));
    const runs = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.$transaction((tx) =>
          createRun(tx, { loopId: loop.id, projectId: ids.project, trigger: "manual" }),
        ),
      ),
    );
    expect(runs.map((r) => r.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it("refuses a second run for the same claimed slot", async () => {
    const loop = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("gamma")));
    const slotAt = new Date("2026-11-12T09:00:00Z");
    await db.$transaction((tx) =>
      createRun(tx, { loopId: loop.id, projectId: ids.project, trigger: "schedule", slotAt }),
    );
    await expect(
      db.$transaction((tx) =>
        createRun(tx, { loopId: loop.id, projectId: ids.project, trigger: "schedule", slotAt }),
      ),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("upserts memory by key and hides expired notes", async () => {
    const now = new Date("2026-11-11T12:00:00Z");
    await db.$transaction(async (tx) => {
      await upsertMemory(tx, {
        projectId: ids.project,
        loopId: null,
        key: "shared",
        content: "one",
      });
      await upsertMemory(tx, {
        projectId: ids.project,
        loopId: null,
        key: "shared",
        content: "two",
      });
      await upsertMemory(tx, {
        projectId: ids.project,
        loopId: null,
        key: "old",
        content: "x",
        expiresAt: new Date(now.getTime() - 1),
      });
    });
    const live = await listMemory(db, { projectId: ids.project, now });
    expect(live.map((m) => [m.key, m.content])).toEqual([["shared", "two"]]);
    expect(
      await listMemory(db, { projectId: ids.project, now, includeExpired: true }),
    ).toHaveLength(2);
  });

  it("rolls up the last run, counted runs and mean cost per Loop", async () => {
    const loop = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("delta")));
    await db.$transaction(async (tx) => {
      await createRun(tx, {
        loopId: loop.id,
        projectId: ids.project,
        trigger: "manual",
        status: "succeeded",
        data: { costUsd: 0.2 },
      });
      await createRun(tx, {
        loopId: loop.id,
        projectId: ids.project,
        trigger: "manual",
        status: "failed",
        data: { costUsd: 0.4 },
      });
      await createRun(tx, {
        loopId: loop.id,
        projectId: ids.project,
        trigger: "manual",
        status: "skipped_blocked",
      });
    });
    const summary = await getLoopSummary(db, ids.project, loop.id);
    expect(COUNTED_RUN_STATUSES).toContain("failed");
    expect(summary).toMatchObject({
      runCount: 2,
      avgCostUsd: expect.closeTo(0.3, 6),
      lastRun: { seq: 3, status: "skipped_blocked" },
    });
    const listed = await listLoops(db, { projectId: ids.project, page: 0, limit: 50 });
    expect(listed.meta.total).toBeGreaterThanOrEqual(3);
  });
});
