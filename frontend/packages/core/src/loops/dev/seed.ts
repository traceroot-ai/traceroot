/**
 * Dev and test seed for the Loops screens: five Loops in every state the UI
 * shows, with runs of every outcome, findings, memory and a transcript per
 * finished run. It writes through the same calls the API uses
 * (createLoopWithDetector, createRun, upsertMemory), so the rows are the ones
 * the product reads. Everything it creates is recognisable (see SEED_ACTOR)
 * so `cleanLoops` removes exactly that and leaves the project's own data.
 *
 * Run through scripts/seed-loops.ts; it refuses outside development and test.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { LOOP_DETECTOR_TEMPLATE, loopSignalGroupKey } from "../keys.ts";
import { createLoopWithDetector, createRun, upsertMemory } from "../writes.ts";
import { COUNTED_RUN_STATUSES, type LoopRunStatus } from "../contracts.ts";
import type { LoopSchedule } from "../schedule.ts";
import { LOOP_TEMPLATES, getLoopTemplate } from "../templates.ts";

/** `Loop.createdBy` of every seeded Loop: the marker `cleanLoops` finds them by. */
export const SEED_ACTOR = "loops-seed";

/**
 * `updatedByRunId` of every note the seed writes. Memory is shared, so a Loop can
 * rewrite a seeded key; this marker tells the seed's notes from theirs.
 */
const SEED_MEMORY_RUN_ID = "seed-memory";

/** The start of every seeded hit's `runId`: the marker for a deleted seeded Loop's signals. */
const SEED_HIT_PREFIX = "seed-";

export interface SeedOptions {
  /** Put the workspace on Free with the Loop cap reached (30 / 30, runs blocked); a clean puts its plan back. */
  freeCap?: boolean;
  /** Turn queued runs into a finished fixture outcome, for demos without a worker. */
  completePending?: boolean;
  /** Reference time; tests pin it, the CLI uses now. */
  now?: Date;
}

export interface SeedCounts {
  loops: number;
  detectors: number;
  runs: number;
  signals: number;
  signalHits: number;
  memories: number;
  sessions: number;
  messages: number;
}

const HOUR = 3_600_000;
const BYOK_MESSAGE = 'BYOK provider "my-openai" not found or disabled in workspace settings';
const TIMEOUT_MESSAGE = "The run did not finish within 20 minutes and was stopped.";

type Db = PrismaClient | Prisma.TransactionClient;

interface RunSpec {
  status: LoopRunStatus;
  hoursAgo: number;
  trigger?: "schedule" | "manual";
  summary?: string;
  error?: string;
  findingKeys?: string[];
  tracesRead?: number;
  costUsd?: number;
  /** Writes a transcript for the run. */
  session?: boolean;
  durationMin?: number;
}

interface FindingSpec {
  key: string;
  title: string;
  covers: string;
  status: "open" | "resolved" | "dismissed";
  hits: number;
}

interface LoopSpec {
  name: string;
  template: string | null;
  /** The whole prompt a run follows; a templated Loop's starts as its template's. */
  instructions: string;
  schedule: LoopSchedule;
  dryRun?: boolean;
  status?: "active" | "paused" | "paused_by_system";
  failureStreak?: number;
  runs: RunSpec[];
  findings?: FindingSpec[];
}

const sched = { trigger: "schedule" as const };
const quiet = (
  hoursAgo: number,
  summary: string,
  tracesRead: number,
  costUsd: number,
  durationMin: number,
): RunSpec => ({
  ...sched,
  status: "quiet",
  hoursAgo,
  summary,
  tracesRead,
  costUsd,
  session: true,
  durationMin,
});
const succeeded = (
  hoursAgo: number,
  summary: string,
  findingKeys: string[],
  tracesRead: number,
  costUsd: number,
  durationMin: number,
): RunSpec => ({
  ...sched,
  status: "succeeded",
  hoursAgo,
  summary,
  findingKeys,
  tracesRead,
  costUsd,
  session: true,
  durationMin,
});
const skipped = (hoursAgo: number, note: string): RunSpec => ({
  ...sched,
  status: "skipped_blocked",
  hoursAgo,
  error: note,
});
const finding = (
  key: string,
  title: string,
  covers: string,
  status: FindingSpec["status"],
  hits: number,
): FindingSpec => ({
  key,
  title,
  covers,
  status,
  hits,
});

const LOOPS: LoopSpec[] = [
  {
    name: "Coding agents",
    template: "coding-agents",
    instructions: getLoopTemplate("coding-agents")!.defaultInstructions,
    schedule: { kind: "daily", hour: 9, timezone: "Europe/Berlin" },
    runs: [
      succeeded(
        3,
        "Two recurring problems in 41 sessions: agents re-reading the same large file after every edit, and test runs started before dependencies were installed. Both recorded with a suggested change.",
        ["repeated-full-file-reads", "tests-before-install"],
        19,
        0.412,
        7,
      ),
      quiet(27, "Nothing new beyond the two open findings.", 8, 0.131, 3),
      succeeded(
        51,
        "Agents still re-read large files after each edit (re-confirmed in 7 sessions).",
        ["repeated-full-file-reads"],
        11,
        0.158,
        4,
      ),
      succeeded(
        75,
        "Agents re-read the same large file after every edit, and hand-edited a lockfile that the next install rewrote.",
        ["repeated-full-file-reads", "stale-lockfile-edits"],
        13,
        0.264,
        5,
      ),
      {
        ...sched,
        status: "timed_out",
        hoursAgo: 147,
        error: TIMEOUT_MESSAGE,
        tracesRead: 25,
        costUsd: 0.871,
        session: true,
        durationMin: 20,
      },
      skipped(171, "Skipped: the workspace reached its loop run limit."),
    ],
    findings: [
      finding(
        "repeated-full-file-reads",
        "Agents re-read the same large file after every edit",
        "Sessions where the same file over 1,000 lines is read in full three or more times in one task.",
        "open",
        6,
      ),
      finding(
        "tests-before-install",
        "Test runs started before dependencies were installed",
        "Sessions whose first test command fails with a missing-module error that an install step would have fixed.",
        "open",
        4,
      ),
      finding(
        "stale-lockfile-edits",
        "Edits to a lockfile that a later install reverted",
        "Sessions that hand-edit a lockfile and then run an install that rewrites it.",
        "resolved",
        3,
      ),
    ],
  },
  {
    name: "Flaky test sweep",
    template: null,
    instructions:
      "Find tests that fail and then pass on retry within the same session. Report a test only if it flaked in at least three sessions.",
    schedule: { kind: "weekly", weekday: 1, hour: 8, timezone: "America/New_York" },
    status: "paused",
    runs: [
      succeeded(70, "One test flaked in five sessions.", ["checkout-test-flake"], 14, 0.233, 5),
      quiet(238, "No test crossed the three-session bar.", 9, 0.12, 3),
    ],
    findings: [
      finding(
        "checkout-test-flake",
        "Checkout test passes only on retry",
        "Sessions where the checkout integration test fails once and passes unchanged on retry.",
        "dismissed",
        5,
      ),
    ],
  },
  {
    name: "Release regressions",
    template: null,
    instructions:
      "Compare error rates across the last two releases and report a regression only when it is confirmed in several traces.",
    schedule: { kind: "daily", hour: 6, timezone: "UTC" },
    status: "paused_by_system",
    failureStreak: 5,
    runs: [1, 2, 3, 4, 5].map((i) => ({
      ...sched,
      status: "failed" as const,
      hoursAgo: i * 24,
      error: BYOK_MESSAGE,
    })),
  },
  {
    name: "Prompt drift watch",
    template: null,
    instructions:
      "Look for tool calls that start failing after a prompt change. Dry run: record a summary only.",
    schedule: { kind: "interval", intervalHours: 6 },
    dryRun: true,
    runs: [
      { ...sched, status: "running", hoursAgo: 0.07 },
      quiet(6, "Dry run: nothing would have been recorded.", 12, 0.102, 4),
    ],
  },
  {
    name: "Tool error clusters",
    template: null,
    instructions:
      "Cluster tool errors by message and report clusters that appear in more than ten traces a day.",
    schedule: { kind: "interval", intervalHours: 12 },
    runs: [
      succeeded(14, "One cluster crossed the bar.", ["timeout-in-search-tool"], 22, 0.347, 6),
      { status: "pending", hoursAgo: 0.02, trigger: "manual" },
    ],
    findings: [
      finding(
        "timeout-in-search-tool",
        "Search tool times out on queries over 500 characters",
        "Traces where the search tool call exceeds its timeout and the query is longer than 500 characters.",
        "open",
        12,
      ),
    ],
  },
];

const STALE_MEMORY_DAYS = 3;

/** Remove everything the seed created in the project, and the Free-cap state it set. */
export async function cleanLoops(db: PrismaClient, projectId: string): Promise<void> {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  await db.$transaction(async (tx) => {
    const loops = await tx.loop.findMany({
      where: { projectId, createdBy: SEED_ACTOR },
      select: { id: true, detectorId: true },
    });
    // Sessions first: their messages cascade, and LoopRun.sessionId only nulls.
    await tx.aISession.deleteMany({
      where: { projectId, id: { in: await seededSessionIds(tx, loops) } },
    });
    // A seeded Loop deleted since (in the UI, say) left its detector and signals; the
    // seed's hit marker tells them from a real deleted Loop's, which stay.
    const orphans = await tx.detector.findMany({
      where: { projectId, template: LOOP_DETECTOR_TEMPLATE, loop: { is: null } },
      select: { id: true },
    });
    const leftBehind = await tx.signal.findMany({
      where: {
        projectId,
        detectorId: { in: orphans.map((d) => d.id) },
        hits: { some: { runId: { startsWith: SEED_HIT_PREFIX } } },
      },
      select: { detectorId: true },
    });
    const detectorIds = [
      ...new Set([...loops.map((l) => l.detectorId), ...leftBehind.map((s) => s.detectorId)]),
    ];
    // Hits cascade with their signals.
    await tx.signal.deleteMany({ where: { projectId, detectorId: { in: detectorIds } } });
    await tx.loopMemory.deleteMany({ where: { projectId, updatedByRunId: SEED_MEMORY_RUN_ID } });
    await tx.loop.deleteMany({ where: { id: { in: loops.map((l) => l.id) } } });
    await tx.detector.deleteMany({ where: { id: { in: detectorIds } } });

    await setLoopUsage(tx, project.workspaceId, null);
  });
}

export async function seedLoops(
  db: PrismaClient,
  projectId: string,
  options: SeedOptions = {},
): Promise<SeedCounts> {
  const now = options.now ?? new Date();
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { workspaceId: true },
  });

  await cleanLoops(db, projectId);

  await db.$transaction(
    async (tx) => {
      const loopIds: Record<string, string> = {};
      for (const spec of LOOPS) {
        const template = LOOP_TEMPLATES.find((t) => t.id === spec.template) ?? null;
        if (spec.instructions.trim().length === 0) {
          throw new Error(`Seed Loop "${spec.name}" has no instructions`);
        }
        const loop = await createLoopWithDetector(tx, {
          projectId,
          createdBy: SEED_ACTOR,
          name: spec.name,
          template: template?.id ?? null,
          instructions: spec.instructions,
          schedule: spec.schedule,
          dryRun: spec.dryRun ?? false,
          lookbackHours: template?.lookbackHours ?? 24,
          model: null,
          provider: null,
          source: null,
          now,
        });
        loopIds[spec.name] = loop.id;

        let lastRunAt: Date | null = null;
        // The finished runs and what they recorded, for the findings below.
        const finishedRuns: { findingKeys: string[]; startedAt: Date; finishedAt: Date }[] = [];
        // Oldest first, so sequence numbers follow time.
        for (const run of [...spec.runs].sort((a, b) => b.hoursAgo - a.hoursAgo)) {
          const created = ago(run.hoursAgo);
          const finished = !["pending", "running"].includes(run.status);
          const started = run.status === "pending" ? null : created;
          const finishedAt =
            finished && started
              ? new Date(started.getTime() + (run.durationMin ?? 0) * 60_000)
              : null;
          const counted = COUNTED_RUN_STATUSES.includes(run.status);
          if (counted && (!lastRunAt || created > lastRunAt)) lastRunAt = created;

          const row = await createRun(tx, {
            loopId: loop.id,
            projectId,
            trigger: run.trigger ?? "schedule",
            slotAt: run.trigger === "manual" ? null : created,
            status: run.status,
            data: {
              startedAt: started,
              finishedAt,
              summary: run.summary ?? null,
              error: run.error ?? null,
              findingKeys: run.findingKeys ?? [],
              tracesRead: run.tracesRead ?? 0,
              costUsd: run.costUsd ?? null,
              createTime: created,
              metadata: {
                model: "claude-sonnet-4-5",
                provider: "anthropic",
                source: "system",
                promptVersion: "seed",
                trigger: run.trigger ?? "schedule",
                limits: { toolCalls: 80, traceReads: 25, minutes: 20 },
              },
            },
          });

          if (row.startedAt && row.finishedAt) {
            finishedRuns.push({
              findingKeys: row.findingKeys,
              startedAt: row.startedAt,
              finishedAt: row.finishedAt,
            });
          }

          if (run.session) {
            const session = await tx.aISession.create({
              data: {
                projectId,
                workspaceId: project.workspaceId,
                title: `${spec.name} · run ${row.seq}`,
                status: "completed",
                metadata: { kind: "loop", seed: true },
                createTime: created,
              },
            });
            await tx.aIMessage.createMany({
              data: transcript(spec, run, project.workspaceId, session.id, created),
            });
            await tx.loopRun.update({ where: { id: row.id }, data: { sessionId: session.id } });
          }
        }

        await tx.loop.update({
          where: { id: loop.id },
          data: {
            lastRunAt,
            failureStreak: spec.failureStreak ?? 0,
            status: spec.status ?? "active",
          },
        });

        for (const finding of spec.findings ?? []) {
          // The runs that recorded the finding: the signal panel links to them,
          // and each hit is one of their traces.
          const seenIn = finishedRuns.filter((r) => r.findingKeys.includes(finding.key));
          if (seenIn.length === 0) {
            throw new Error(`Seed finding "${finding.key}" is recorded by none of its Loop's runs`);
          }
          await seedFinding(tx, projectId, loop.detectorId, finding, seenIn, now);
        }
      }

      const writer = loopIds["Coding agents"];
      await upsertMemory(tx, {
        projectId,
        loopId: null,
        key: "repo-conventions",
        runId: SEED_MEMORY_RUN_ID,
        content:
          "Services live under frontend/; agent runs are labelled by repository. Test commands run from the package root.",
      });
      await upsertMemory(tx, {
        projectId,
        loopId: writer,
        key: "known-flaky-tests",
        runId: SEED_MEMORY_RUN_ID,
        content:
          "The checkout integration test flakes on retry; it is already tracked and should not be reported again.",
      });
      await upsertMemory(tx, {
        projectId,
        loopId: writer,
        key: "ci-outage-window",
        runId: SEED_MEMORY_RUN_ID,
        content:
          "CI was degraded; failures before the window ends are environmental, not agent behaviour.",
        expiresAt: new Date(now.getTime() + STALE_MEMORY_DAYS * 24 * HOUR),
      });

      if (options.completePending) {
        const pending = await tx.loopRun.findMany({ where: { projectId, status: "pending" } });
        for (const run of pending) {
          await tx.loopRun.update({
            where: { id: run.id },
            data: {
              status: "quiet",
              startedAt: now,
              finishedAt: new Date(now.getTime() + 2 * 60_000),
              summary: "Completed by the seed: nothing reached the bar for a finding.",
              tracesRead: 6,
              costUsd: 0.08,
            },
          });
        }
      }

      if (options.freeCap) await setLoopUsage(tx, project.workspaceId, 30);
    },
    { timeout: 60_000 },
  );

  return countLoops(db, projectId);
}

/**
 * The workspace's Loop meter. `runsUsed` puts it on Free with runs blocked and
 * keeps the plan it had in the seed's meter; null takes that meter away and puts
 * the plan back. A meter the seed did not write is left alone.
 */
async function setLoopUsage(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  runsUsed: number | null,
) {
  const ws = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { currentUsage: true, billingPlan: true },
  });
  const usage = { ...((ws.currentUsage ?? {}) as Record<string, unknown>) };
  const seeded = usage.loop as { seedPreviousPlan?: string } | undefined;
  if (runsUsed === null) {
    if (seeded?.seedPreviousPlan === undefined) return;
    delete usage.loop;
  } else {
    usage.loop = {
      runsUsed,
      systemTokenCost: 0,
      systemInputTokens: 0,
      systemOutputTokens: 0,
      seedPreviousPlan: ws.billingPlan,
    };
  }
  await tx.workspace.update({
    where: { id: workspaceId },
    data: {
      loopBlocked: runsUsed !== null,
      billingPlan: runsUsed === null ? seeded!.seedPreviousPlan : "free",
      currentUsage: usage as Prisma.InputJsonObject,
    },
  });
}

/** How far apart the seeded traces of one recording run start, going back from the run. */
const TRACE_SPACING_MIN = 20;

/**
 * The signal and its hits. Hits are dealt across the runs that recorded the
 * finding: each is seen when its run finished and its trace started inside that
 * run's look-back, before the run, so the signal list and panel (which window
 * on the trace's start) count it in the window that holds the run.
 */
async function seedFinding(
  tx: Prisma.TransactionClient,
  projectId: string,
  detectorId: string,
  finding: FindingSpec,
  seenIn: { startedAt: Date; finishedAt: Date }[],
  now: Date,
): Promise<void> {
  const hits = Array.from({ length: finding.hits }, (_, i) => {
    const run = seenIn[i % seenIn.length];
    const back = (Math.floor(i / seenIn.length) + 1) * TRACE_SPACING_MIN * 60_000;
    return {
      seenAt: run.finishedAt,
      traceStartTime: new Date(run.startedAt.getTime() - back),
    };
  });
  const seenAts = hits.map((h) => h.seenAt.getTime());
  const signal = await tx.signal.create({
    data: {
      projectId,
      detectorId,
      title: finding.title,
      criteriaCovers: finding.covers,
      criteriaExcludes: "",
      anchorText: finding.title,
      groupKey: loopSignalGroupKey(finding.key),
      status: finding.status,
      resolvedAt: finding.status === "resolved" ? new Date(now.getTime() - 24 * HOUR) : null,
      hitCount: finding.hits,
      firstSeenAt: new Date(Math.min(...seenAts)),
      lastSeenAt: new Date(Math.max(...seenAts)),
    },
  });
  await tx.signalHit.createMany({
    data: hits.map((hit, i) => ({
      runId: `${SEED_HIT_PREFIX}${signal.id}-${i}`,
      signalId: signal.id,
      projectId,
      detectorId,
      traceId: `seed-trace-${signal.id}-${i}`,
      findingId: `seed-finding-${signal.id}-${i}`,
      seenAt: hit.seenAt,
      traceStartTime: hit.traceStartTime,
      assignedAt: hit.seenAt,
      copyPending: false,
    })),
  });
}

function transcript(
  spec: LoopSpec,
  run: RunSpec,
  workspaceId: string,
  sessionId: string,
  at: Date,
): Prisma.AIMessageCreateManyInput[] {
  const base = {
    workspaceId,
    sessionId,
    kind: "loop",
    turnKind: "loop_execution" as const,
    isByok: false,
  };
  const step = (i: number) => new Date(at.getTime() + i * 20_000);
  return [
    {
      ...base,
      role: "user",
      content: `Run the "${spec.name}" loop. Look back 24 hours.`,
      createTime: step(0),
    },
    {
      ...base,
      role: "assistant",
      content: "Recalling notes and past runs, then measuring with SQL before reading traces.",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 5200,
      outputTokens: 310,
      cost: 0.03,
      createTime: step(1),
    },
    {
      ...base,
      role: "tool",
      content: "run_sql: 41 sessions in the window, 9 with a failed first command.",
      metadata: { tool: "run_sql" },
      createTime: step(2),
    },
    {
      ...base,
      role: "assistant",
      content: run.summary ?? run.error ?? "Run finished.",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 9100,
      outputTokens: 420,
      cost: run.costUsd ?? 0,
      createTime: step(3),
    },
  ];
}

/** The transcripts of the seeded Loops' runs. */
async function seededSessionIds(db: Db, loops: { id: string }[]): Promise<string[]> {
  const runs = await db.loopRun.findMany({
    where: { loopId: { in: loops.map((l) => l.id) }, sessionId: { not: null } },
    select: { sessionId: true },
  });
  return runs.map((r) => r.sessionId!);
}

export async function countLoops(db: Db, projectId: string): Promise<SeedCounts> {
  const loops = await db.loop.findMany({
    where: { projectId, createdBy: SEED_ACTOR },
    select: { id: true, detectorId: true },
  });
  const loopIds = loops.map((l) => l.id);
  const detectorIds = loops.map((l) => l.detectorId);
  const runs = await db.loopRun.count({ where: { loopId: { in: loopIds } } });
  const sessionIds = await seededSessionIds(db, loops);
  const [detectors, signals, signalHits, memories, messages] = await Promise.all([
    db.detector.count({ where: { id: { in: detectorIds } } }),
    db.signal.count({ where: { projectId, detectorId: { in: detectorIds } } }),
    db.signalHit.count({ where: { projectId, detectorId: { in: detectorIds } } }),
    db.loopMemory.count({ where: { projectId, updatedByRunId: SEED_MEMORY_RUN_ID } }),
    db.aIMessage.count({ where: { sessionId: { in: sessionIds } } }),
  ]);
  return {
    loops: loops.length,
    detectors,
    runs,
    signals,
    signalHits,
    memories,
    sessions: sessionIds.length,
    messages,
  };
}
