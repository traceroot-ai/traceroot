/**
 * Runs the Loop data layer against a real Postgres with the migrations applied.
 * Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter @traceroot/core test loops.db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { LOOP_DETECTOR_TEMPLATE } from "../keys.ts";
import {
  createLoopWithDetector,
  createRun,
  deleteLoopKeepingDetector,
  hasActiveRun,
  lockLoop,
  projectAtLoopCap,
  renameLoopDetector,
  upsertMemory,
} from "../writes.ts";
import {
  countFreeLoopRunsUsed,
  countProjectLoopRunsSince,
  existingLoopSignals,
  getLoopRun,
  getLoopSummary,
  listLoops,
  listMemory,
} from "../queries.ts";
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
  it("lists a Loop's signals with the reason behind their status", async () => {
    const loop = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("theta")));
    const other = await db.$transaction((tx) => createLoopWithDetector(tx, newLoop("iota")));
    const signal = (data: {
      groupKey: string | null;
      title: string;
      status?: string;
      seenDay: number;
      detectorId?: string;
    }) => {
      const at = new Date(Date.UTC(2026, 10, data.seenDay));
      return db.signal.create({
        data: {
          projectId: ids.project,
          detectorId: data.detectorId ?? loop.detectorId,
          title: data.title,
          criteriaCovers: "c",
          criteriaExcludes: "",
          anchorText: data.title,
          groupKey: data.groupKey,
          status: data.status ?? "open",
          hitCount: 1,
          firstSeenAt: at,
          lastSeenAt: at,
        },
      });
    };
    const statusEvent = (
      signalId: string,
      fromStatus: string,
      toStatus: string,
      reason: string | null,
      note: string | null,
      minute: number,
    ) =>
      db.signalStatusEvent.create({
        data: {
          signalId,
          actorUserId: reason === "new_hit" ? "system" : "u1",
          fromStatus,
          toStatus,
          reason,
          note,
          createTime: new Date(Date.UTC(2026, 10, 20, 0, minute)),
        },
      });

    const open = await signal({
      groupKey: "loop:tool-timeouts",
      title: "Tool calls time out",
      seenDay: 20,
    });
    const dismissed = await signal({
      groupKey: "loop:retry-storm",
      title: "Retries pile up",
      status: "dismissed",
      seenDay: 19,
    });
    await statusEvent(dismissed.id, "open", "resolved", "fixed_by_pr", "old fix", 1);
    await statusEvent(dismissed.id, "resolved", "open", "new_hit", null, 2);
    await statusEvent(
      dismissed.id,
      "open",
      "dismissed",
      "expected_behavior",
      "Retries are the design here.",
      3,
    );
    const reopened = await signal({
      groupKey: "loop:wrong-city",
      title: "Wrong city booked",
      seenDay: 18,
    });
    await statusEvent(reopened.id, "open", "resolved", "fixed_by_pr", "Fixed in #12", 1);
    await statusEvent(reopened.id, "resolved", "open", "new_hit", null, 2);
    const merged = await signal({
      groupKey: "loop:slow-search",
      title: "Search is slow",
      seenDay: 17,
    });
    await db.signal.update({ where: { id: merged.id }, data: { mergedIntoId: open.id } });
    // Not listed: an empty key, a signal without a Loop key, another Loop's signal.
    await signal({ groupKey: "loop:", title: "empty key", seenDay: 21 });
    await signal({ groupKey: null, title: "model-assigned", seenDay: 21 });
    await signal({
      groupKey: "loop:elsewhere",
      title: "other loop",
      seenDay: 21,
      detectorId: other.detectorId,
    });

    expect(await existingLoopSignals(db, ids.project, loop.detectorId)).toEqual([
      {
        key: "tool-timeouts",
        signalId: open.id,
        title: "Tool calls time out",
        status: "open",
        reason: null,
        note: null,
        mergedIntoId: null,
      },
      {
        key: "retry-storm",
        signalId: dismissed.id,
        title: "Retries pile up",
        status: "dismissed",
        reason: "expected_behavior",
        note: "Retries are the design here.",
        mergedIntoId: null,
      },
      {
        // Resolved, then reopened by a new hit: the resolve reason no longer applies.
        key: "wrong-city",
        signalId: reopened.id,
        title: "Wrong city booked",
        status: "open",
        reason: null,
        note: null,
        mergedIntoId: null,
      },
      {
        key: "slow-search",
        signalId: merged.id,
        title: "Search is slow",
        status: "open",
        reason: null,
        note: null,
        mergedIntoId: open.id,
      },
    ]);
    expect(await existingLoopSignals(db, ids.project, `${loop.detectorId}_none`)).toEqual([]);
  });

  it("finds Loops by name, renames the hidden detector, and reads one run only in its Loop", async () => {
    const loop = await db.$transaction((tx) =>
      createLoopWithDetector(tx, newLoop("Search Target")),
    );
    const other = await db.$transaction((tx) =>
      createLoopWithDetector(tx, newLoop("Search Other")),
    );

    const found = await listLoops(db, {
      projectId: ids.project,
      search: "search tar",
      page: 0,
      limit: 50,
    });
    expect(found.data.map((l) => l.name)).toEqual(["Search Target"]);
    // A Loop that never ran has no last run and no mean cost.
    expect(found.data[0]).toMatchObject({ lastRun: null, runCount: 0, avgCostUsd: null });

    await db.$transaction((tx) => renameLoopDetector(tx, loop, "Search Renamed"));
    expect(await db.detector.findUniqueOrThrow({ where: { id: loop.detectorId } })).toMatchObject({
      name: "loop:Search Renamed",
    });

    const run = await db.$transaction((tx) =>
      createRun(tx, { loopId: loop.id, projectId: ids.project, trigger: "manual" }),
    );
    expect(await getLoopRun(db, loop.id, run.id)).toMatchObject({ id: run.id, seq: 1 });
    expect(await getLoopRun(db, other.id, run.id)).toBeNull();
  });

  it("counts a workspace's Loop runs used: replied sessions, plus running runs yet to reply", async () => {
    // A workspace of its own, so other tests' runs do not count here.
    const workspaceId = `w_used_${suffix}`;
    const projectId = `p_used_${suffix}`;
    await db.workspace.create({ data: { id: workspaceId, name: `used ${suffix}` } });
    await db.project.create({ data: { id: projectId, workspaceId, name: "p" } });
    try {
      const loop = await db.$transaction((tx) =>
        createLoopWithDetector(tx, { ...newLoop("used"), projectId }),
      );
      const session = (id: string) =>
        db.aISession.create({ data: { id, projectId, workspaceId, status: "completed" } });
      const message = (sessionId: string, role: string, content: string, kind = "loop") =>
        db.aIMessage.create({ data: { workspaceId, sessionId, kind, role, content } });
      // Replied with a tool call (twice in one session: counted once), and with text.
      await session(`s_tool_${suffix}`);
      await message(`s_tool_${suffix}`, "tool_step", "list_traces");
      await message(`s_tool_${suffix}`, "tool_step", "get_trace");
      await session(`s_text_${suffix}`);
      await message(`s_text_${suffix}`, "assistant", "nothing new");
      // Not replied: the model failed and left an empty assistant row; not a Loop turn.
      await session(`s_failed_${suffix}`);
      await message(`s_failed_${suffix}`, "assistant", "");
      await session(`s_chat_${suffix}`);
      await message(`s_chat_${suffix}`, "assistant", "hello", "chat");
      // Running, one per Loop as a Loop never has two: one before its session, and one
      // that has already replied (counted above).
      const second = await db.$transaction((tx) =>
        createLoopWithDetector(tx, { ...newLoop("used-2"), projectId }),
      );
      const running = async (loopId: string, sessionId: string | null) => {
        const run = await db.$transaction((tx) =>
          createRun(tx, { loopId, projectId, trigger: "manual" }),
        );
        await db.loopRun.update({ where: { id: run.id }, data: { status: "running", sessionId } });
      };
      await running(loop.id, null);
      await running(second.id, `s_tool_${suffix}`);

      expect(await db.$transaction((tx) => countFreeLoopRunsUsed(tx, workspaceId))).toBe(3);
      expect(await db.$transaction((tx) => countFreeLoopRunsUsed(tx, ids.workspace))).toBe(0);
    } finally {
      await db.workspace.delete({ where: { id: workspaceId } });
    }
  });

  it("counts a project's runs since a time in one statement: Loop turns, plus running runs before theirs", async () => {
    // A workspace of its own, so other tests' runs do not count here.
    const workspaceId = `w_daily_${suffix}`;
    const projectId = `p_daily_${suffix}`;
    const otherProjectId = `p_daily_other_${suffix}`;
    await db.workspace.create({ data: { id: workspaceId, name: `daily ${suffix}` } });
    await db.project.create({ data: { id: projectId, workspaceId, name: "p" } });
    await db.project.create({ data: { id: otherProjectId, workspaceId, name: "q" } });
    // Records every operation the count issues, raw or through a model.
    const operations: string[] = [];
    const recorded = db.$extends({
      query: {
        async $allOperations({ model, operation, args, query }) {
          operations.push(model ? `${model}.${operation}` : operation);
          return query(args);
        },
      },
    }) as unknown as Prisma.TransactionClient;
    try {
      const since = new Date("2026-11-20T00:00:00Z");
      const before = new Date("2026-11-19T23:00:00Z");
      const after = new Date("2026-11-20T01:00:00Z");
      const session = (id: string, project = projectId) =>
        db.aISession.create({
          data: { id, projectId: project, workspaceId, status: "completed" },
        });
      const message = (sessionId: string, createTime: Date, kind = "loop") =>
        db.aIMessage.create({
          data: { workspaceId, sessionId, kind, role: "user", content: "go", createTime },
        });
      // Two Loop turns in the window, one with two Loop rows (counted once).
      await session(`s_d_one_${suffix}`);
      await message(`s_d_one_${suffix}`, after);
      await message(`s_d_one_${suffix}`, after);
      await session(`s_d_two_${suffix}`);
      await message(`s_d_two_${suffix}`, after);
      // Not counted: a Loop turn before `since`, a chat, another project's Loop turn.
      await session(`s_d_old_${suffix}`);
      await message(`s_d_old_${suffix}`, before);
      await session(`s_d_chat_${suffix}`);
      await message(`s_d_chat_${suffix}`, after, "chat");
      await session(`s_d_other_${suffix}`, otherProjectId);
      await message(`s_d_other_${suffix}`, after);

      const running = async (
        name: string,
        sessionId: string | null,
        createTime: Date,
        project = projectId,
      ) => {
        const loop = await db.$transaction((tx) =>
          createLoopWithDetector(tx, { ...newLoop(name), projectId: project }),
        );
        const run = await db.$transaction((tx) =>
          createRun(tx, { loopId: loop.id, projectId: project, trigger: "manual" }),
        );
        await db.loopRun.update({
          where: { id: run.id },
          data: { status: "running", sessionId, createTime },
        });
      };
      // Counted: running before its session, and running with a session but no Loop turn yet.
      await running("d-no-session", null, after);
      await session(`s_d_pending_${suffix}`);
      await running("d-pending", `s_d_pending_${suffix}`, after);
      // Counted once, as its Loop turn: running and already past its kickoff.
      await running("d-started", `s_d_one_${suffix}`, after);
      // Not counted: running since before `since`, and another project's running run.
      await running("d-old", null, before);
      await running("d-other", null, after, otherProjectId);

      expect(await countProjectLoopRunsSince(recorded, projectId, since)).toBe(4);
      expect(operations).toEqual(["$queryRaw"]);
      expect(await countProjectLoopRunsSince(recorded, otherProjectId, since)).toBe(2);
      expect(await countProjectLoopRunsSince(recorded, projectId, after)).toBe(4);
      expect(
        await countProjectLoopRunsSince(recorded, projectId, new Date("2026-11-20T02:00:00Z")),
      ).toBe(0);
    } finally {
      await db.workspace.delete({ where: { id: workspaceId } });
    }
  });
});
