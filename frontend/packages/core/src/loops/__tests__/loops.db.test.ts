/**
 * Runs the Loop data layer against a real Postgres with the migrations applied.
 * Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter @traceroot/core test loops.db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createLoopWithDetector,
  deleteLoopWithDetector,
  LOOP_DETECTOR_TEMPLATE,
} from "../detector.ts";
import { upsertMemory, listMemory } from "../memory.ts";
import { createRun } from "../runs.ts";
import { getLoopSummary, listLoops } from "../queries.ts";
import { COUNTED_RUN_STATUSES } from "../contracts.ts";

const url = process.env.TEST_DATABASE_URL;
const suffix = Math.random().toString(36).slice(2, 8);
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as never);
const ids = { workspace: `w_loops_${suffix}`, project: `p_loops_${suffix}` };

const newLoop = (name: string) => ({
  projectId: ids.project,
  createdBy: "u1",
  name,
  template: null,
  templateVersion: null,
  instructions: "look",
  schedule: { kind: "interval" as const, intervalHours: 6 },
  dryRun: false,
  precheckSql: null,
  lookbackHours: 24,
  maxFindingsPerRun: 2,
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

  it("creates the Loop with its hidden detector in one call, and deletes both", async () => {
    const loop = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("alpha")));
    const detector = await db.detector.findUniqueOrThrow({ where: { id: loop.detectorId } });
    expect(detector).toMatchObject({
      template: LOOP_DETECTOR_TEMPLATE,
      name: "loop:alpha",
      enabled: false,
      enableSignals: true,
    });
    expect(loop.nextRunAt?.toISOString()).toBe("2026-11-11T06:00:00.000Z");

    await db.$transaction((tx) => deleteLoopWithDetector(tx, loop));
    expect(await db.loop.count({ where: { id: loop.id } })).toBe(0);
    expect(await db.detector.count({ where: { id: loop.detectorId } })).toBe(0);
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
        status: "skipped_precheck",
      });
    });
    const summary = await getLoopSummary(db, ids.project, loop.id);
    expect(COUNTED_RUN_STATUSES).toContain("failed");
    expect(summary).toMatchObject({
      runCount: 2,
      avgCostUsd: expect.closeTo(0.3, 6),
      lastRun: { seq: 3, status: "skipped_precheck" },
    });
    const listed = await listLoops(db, { projectId: ids.project, page: 0, limit: 50 });
    expect(listed.meta.total).toBeGreaterThanOrEqual(3);
  });
});
