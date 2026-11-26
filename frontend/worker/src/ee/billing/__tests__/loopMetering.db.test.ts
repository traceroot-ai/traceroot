/**
 * meterLoopRuns against a real Postgres with the migrations applied: a Loop
 * run is counted from its turn in ai_messages, which outlives the Loop, so
 * deleting a Loop (its loop_runs cascade with it) gives back no runs and does
 * not lift a Free workspace's block. Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter traceroot-worker test db.test
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma, PlanType, LOOP_RUN_QUOTAS } from "@traceroot/core";
import {
  createLoopWithDetector,
  createRun,
  deleteLoopKeepingDetector,
} from "@traceroot/core/loops";
import { meterLoopRuns } from "../loopMetering.js";

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  const url = process.env.TEST_DATABASE_URL;
  return url
    ? { ...actual, prisma: new actual.PrismaClient({ datasources: { db: { url } } }) }
    : actual;
});

const url = process.env.TEST_DATABASE_URL;
const suffix = Math.random().toString(36).slice(2, 8);
const workspaces: string[] = [];
let count = 0;

async function setup(plan: string) {
  count += 1;
  const workspaceId = `w_meter_${suffix}_${count}`;
  const projectId = `p_meter_${suffix}_${count}`;
  workspaces.push(workspaceId);
  await prisma.workspace.create({
    data: { id: workspaceId, name: workspaceId, billingPlan: plan },
  });
  await prisma.project.create({ data: { id: projectId, workspaceId, name: "p" } });
  const loop = await prisma.$transaction((tx) =>
    createLoopWithDetector(tx, {
      projectId,
      createdBy: "u1",
      name: "Coding agents",
      template: null,
      instructions: "look",
      schedule: { kind: "interval", intervalHours: 1 },
      dryRun: false,
      lookbackHours: 24,
      model: null,
      provider: null,
      source: null,
      now: new Date(),
    }),
  );
  return { workspaceId, projectId, loop };
}

type Ids = Awaited<ReturnType<typeof setup>>;

/** A run that called the agent: its session holds the Loop turn, as the agent route persists it. */
async function addAgentRun(ids: Ids) {
  const session = await prisma.aISession.create({
    data: { projectId: ids.projectId, workspaceId: ids.workspaceId },
  });
  const turn = { workspaceId: ids.workspaceId, sessionId: session.id, kind: "loop" } as const;
  await prisma.aIMessage.createMany({
    data: [
      { ...turn, turnKind: "loop_execution", role: "user", content: "Run the loop" },
      // A turn persists one assistant row per text segment; only the last carries usage.
      { ...turn, turnKind: "loop_execution", role: "assistant", content: "Reading traces" },
      {
        ...turn,
        turnKind: "loop_execution",
        role: "assistant",
        content: "Nothing recurring.",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        isByok: false,
        inputTokens: 1000,
        outputTokens: 100,
        cost: 0.01,
      },
    ],
  });
  await prisma.$transaction((tx) =>
    createRun(tx, {
      loopId: ids.loop.id,
      projectId: ids.projectId,
      trigger: "manual",
      status: "quiet",
      data: { sessionId: session.id },
    }),
  );
  return session.id;
}

/**
 * A run whose model failed before answering, as the agent route persists it:
 * the kickoff, then an empty assistant row carrying the error.
 */
async function addFailedModelRun(ids: Ids) {
  const session = await prisma.aISession.create({
    data: { projectId: ids.projectId, workspaceId: ids.workspaceId },
  });
  const turn = {
    workspaceId: ids.workspaceId,
    sessionId: session.id,
    kind: "loop",
    turnKind: "loop_execution",
  } as const;
  await prisma.aIMessage.createMany({
    data: [
      { ...turn, role: "user", content: "Run the loop" },
      { ...turn, role: "assistant", content: "", metadata: { runError: "401 invalid key" } },
    ],
  });
  await prisma.$transaction((tx) =>
    createRun(tx, {
      loopId: ids.loop.id,
      projectId: ids.projectId,
      trigger: "manual",
      status: "failed",
      data: { sessionId: session.id },
    }),
  );
  return session.id;
}

/** A run whose agent answered only with tool calls: no assistant text, a usage-only row. */
async function addToolOnlyRun(ids: Ids) {
  const session = await prisma.aISession.create({
    data: { projectId: ids.projectId, workspaceId: ids.workspaceId },
  });
  const turn = {
    workspaceId: ids.workspaceId,
    sessionId: session.id,
    kind: "loop",
    turnKind: "loop_execution",
  } as const;
  await prisma.aIMessage.createMany({
    data: [
      { ...turn, role: "user", content: "Run the loop" },
      { ...turn, role: "tool_step", content: "", metadata: { toolName: "loop_submit_summary" } },
      {
        ...turn,
        role: "assistant",
        content: "",
        isByok: false,
        inputTokens: 500,
        outputTokens: 50,
      },
    ],
  });
  return session.id;
}

function periodWindow() {
  const now = Date.now();
  return { createTime: { gte: new Date(now - 3_600_000), lt: new Date(now + 3_600_000) } };
}

async function meter(ids: Ids, plan: PlanType) {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: ids.workspaceId },
    select: { id: true, loopBlocked: true },
  });
  return meterLoopRuns(workspace, plan, periodWindow());
}

async function deleteLoop(ids: Ids) {
  await prisma.$transaction((tx) => deleteLoopKeepingDetector(tx, ids.loop));
  expect(await prisma.loopRun.count({ where: { projectId: ids.projectId } })).toBe(0);
}

describe.skipIf(!url)("meterLoopRuns on Postgres", () => {
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.$disconnect();
  });

  it("counts each run that called the agent once, and only those", async () => {
    const ids = await setup("free");
    const sessionId = await addAgentRun(ids);
    await addAgentRun(ids);
    await addAgentRun(ids);
    // A person's follow-up in a run's session is an RCA turn, not another run.
    await prisma.aIMessage.create({
      data: {
        workspaceId: ids.workspaceId,
        sessionId,
        kind: "rca",
        turnKind: "rca_followup",
        role: "assistant",
        content: "Here is why.",
        inputTokens: 10,
        outputTokens: 10,
      },
    });
    // Runs that never called the agent: skipped by a gate, or failed before the call.
    for (const status of ["skipped_blocked", "failed"] as const) {
      await prisma.$transaction((tx) =>
        createRun(tx, { loopId: ids.loop.id, projectId: ids.projectId, trigger: "manual", status }),
      );
    }

    const { usage } = await meter(ids, PlanType.FREE);
    expect(usage.runsUsed).toBe(3);
    expect(usage.systemInputTokens).toBe(3000);
  });

  it("does not count a run whose model failed before it replied", async () => {
    const ids = await setup("free");
    await addAgentRun(ids);
    await addFailedModelRun(ids);
    await addFailedModelRun(ids);

    const { usage } = await meter(ids, PlanType.FREE);
    expect(usage.runsUsed).toBe(1);
  });

  it("counts a run whose agent replied only with tool calls", async () => {
    const ids = await setup("free");
    await addToolOnlyRun(ids);
    await addFailedModelRun(ids);

    const { usage } = await meter(ids, PlanType.FREE);
    expect(usage.runsUsed).toBe(1);
  });

  it("keeps a deleted Loop's runs counted", async () => {
    const ids = await setup("free");
    for (let i = 0; i < 3; i++) await addAgentRun(ids);
    expect((await meter(ids, PlanType.FREE)).usage.runsUsed).toBe(3);

    await deleteLoop(ids);

    const { usage } = await meter(ids, PlanType.FREE);
    expect(usage.runsUsed).toBe(3);
    expect(usage.systemTokenCost).toBeCloseTo(0.03);
  });

  it("keeps a Free workspace blocked after it deletes the Loop that used its runs", async () => {
    const ids = await setup("free");
    const cap = LOOP_RUN_QUOTAS[PlanType.FREE].included;
    for (let i = 0; i < cap; i++) await addAgentRun(ids);
    const first = await meter(ids, PlanType.FREE);
    expect(first.loopBlocked).toBe(true);
    await prisma.workspace.update({ where: { id: ids.workspaceId }, data: { loopBlocked: true } });

    await deleteLoop(ids);

    const after = await meter(ids, PlanType.FREE);
    expect(after.usage.runsUsed).toBe(cap);
    // undefined: the flag does not change, so the workspace stays blocked.
    expect(after.loopBlocked).toBeUndefined();
  });
});
