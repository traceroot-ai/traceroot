/**
 * processLoopRun against a real Postgres with the migrations applied: the
 * start's gates and daily cap, the run's finish and the Loop's failure streak.
 * The agent service (fetch), the model resolver and the window's trace check
 * are faked. Skipped unless
 * TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter traceroot-worker test db.test
 *
 * Every test gets a workspace and project of its own, so no other run counts
 * toward its daily cap, and its Loops have no nextRunAt, so no tick claims them.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@traceroot/core";
import {
  LOOP_LIMITS,
  createLoopWithDetector,
  createRun,
  type LoopAgentResult,
  type LoopRunStatus,
} from "@traceroot/core/loops";
import {
  LOOP_DAILY_CAP_SKIP,
  LOOP_PAUSED_SKIP,
  LOOP_PLAN_SKIP,
  startLoopRun,
} from "../../loops/start.js";
import {
  LOOP_SESSION_TIMEOUT_ERROR,
  LOOP_SESSION_TIMEOUT_MS,
  noTracesSkip,
  processLoopRun,
} from "../loop-run-processor.js";

vi.stubEnv("INTERNAL_API_SECRET", "unit-test-internal-secret-0123456789abcdef");

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  const url = process.env.TEST_DATABASE_URL;
  return url
    ? { ...actual, prisma: new actual.PrismaClient({ datasources: { db: { url } } }) }
    : actual;
});

const mocks = vi.hoisted(() => ({ resolveProjectModel: vi.fn(), windowHasTraces: vi.fn() }));
vi.mock("../../agent/resolve-model.js", () => ({
  resolveProjectModel: mocks.resolveProjectModel,
}));
vi.mock("../../loops/window-traces.js", () => ({ windowHasTraces: mocks.windowHasTraces }));

const url = process.env.TEST_DATABASE_URL;
const suffix = Math.random().toString(36).slice(2, 8);
const workspaces: string[] = [];
let count = 0;

const fetchMock = vi.fn();
let lastSessionId: string | undefined;

/** The agent service's session create: a real row, as the run links to it. */
async function createSession(target: string): Promise<Response> {
  const projectId = /\/projects\/([^/]+)\/sessions$/.exec(target)![1]!;
  const { workspaceId } = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  const session = await prisma.aISession.create({ data: { projectId, workspaceId } });
  lastSessionId = session.id;
  return Response.json({ id: session.id });
}

function agentAnswers(result: Partial<LoopAgentResult>) {
  fetchMock.mockImplementation(async (target: string) => {
    if (target.endsWith("/sessions")) return createSession(target);
    return Response.json({
      status: "submitted",
      summary: "Nothing recurring in the last 24 hours.",
      tracesRead: 7,
      toolCalls: 12,
      costUsd: 0.42,
      error: null,
      modelUsed: { model: "claude-sonnet", provider: "anthropic", source: "system" },
      ...result,
    });
  });
}

interface Setup {
  plan?: string;
  loopBlocked?: boolean;
  project?: { rcaModel?: string; rcaProvider?: string; rcaSource?: string };
  loop?: { model?: string; provider?: string; source?: "system" | "byok"; failureStreak?: number };
}

/** A workspace, project and active Loop of their own. */
async function setup(options: Setup = {}) {
  count += 1;
  const workspaceId = `w_run_${suffix}_${count}`;
  const projectId = `p_run_${suffix}_${count}`;
  workspaces.push(workspaceId);
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      name: workspaceId,
      billingPlan: options.plan ?? "starter",
      loopBlocked: options.loopBlocked ?? false,
    },
  });
  await prisma.project.create({
    data: { id: projectId, workspaceId, name: "p", ...options.project },
  });
  const loop = await prisma.$transaction((tx) =>
    createLoopWithDetector(tx, {
      projectId,
      createdBy: "u1",
      name: "Tool errors",
      template: null,
      instructions: "look",
      schedule: { kind: "interval", intervalHours: 1 },
      dryRun: false,
      lookbackHours: 24,
      model: options.loop?.model ?? null,
      provider: options.loop?.provider ?? null,
      source: options.loop?.source ?? null,
      now: new Date(),
    }),
  );
  await prisma.loop.update({
    where: { id: loop.id },
    data: { nextRunAt: null, failureStreak: options.loop?.failureStreak ?? 0 },
  });
  return { workspaceId, projectId, loopId: loop.id };
}

type Ids = Awaited<ReturnType<typeof setup>>;

async function addRun(
  ids: Ids,
  options: {
    trigger?: "manual" | "schedule";
    status?: LoopRunStatus;
    /** The run called the agent: it has a session. */
    withSession?: boolean;
  } = {},
) {
  const sessionId = options.withSession
    ? (
        await prisma.aISession.create({
          data: { projectId: ids.projectId, workspaceId: ids.workspaceId },
        })
      ).id
    : null;
  return prisma.$transaction((tx) =>
    createRun(tx, {
      loopId: ids.loopId,
      projectId: ids.projectId,
      trigger: options.trigger ?? "manual",
      status: options.status ?? "pending",
      data: { sessionId },
    }),
  );
}

const runJob = (runId: string) => processLoopRun({ data: { runId } });
const runRow = (id: string) => prisma.loopRun.findUniqueOrThrow({ where: { id } });
const loopRow = (id: string) => prisma.loop.findUniqueOrThrow({ where: { id } });

describe.skipIf(!url)("processLoopRun on Postgres", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveProjectModel.mockReset().mockResolvedValue({
      model: "claude-sonnet",
      providerName: "anthropic",
      source: "system",
    });
    mocks.windowHasTraces.mockReset().mockResolvedValue(true);
    agentAnswers({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.$disconnect();
  });

  describe("the start's gates", () => {
    it("does nothing for a run that is no longer pending", async () => {
      const ids = await setup();
      const run = await addRun(ids, { status: "quiet" });
      await runJob(run.id);
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await runRow(run.id)).status).toBe("quiet");
    });

    it("skips a scheduled run whose loop was paused, without counting it", async () => {
      const ids = await setup();
      const run = await addRun(ids, { trigger: "schedule" });
      await prisma.loop.update({ where: { id: ids.loopId }, data: { status: "paused" } });
      await runJob(run.id);
      const after = await runRow(run.id);
      expect(after).toMatchObject({ status: "skipped_paused", error: LOOP_PAUSED_SKIP });
      expect(after.finishedAt).toBeInstanceOf(Date);
      expect((await loopRow(ids.loopId)).failureStreak).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.resolveProjectModel).not.toHaveBeenCalled();
    });

    it("skips a run whose project was deleted", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      await prisma.project.update({
        where: { id: ids.projectId },
        data: { deleteTime: new Date() },
      });
      await runJob(run.id);
      expect(await runRow(run.id)).toMatchObject({ status: "skipped_paused" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not start a run whose loop was paused after the worker loaded it", async () => {
      // The pause lands between the processor's read of the run and its start:
      // the start reads the Loop again, under its row lock, and skips.
      const ids = await setup();
      const run = await addRun(ids);
      const loaded = await prisma.loopRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { loop: true },
      });
      expect(loaded.loop.status).toBe("active");
      await prisma.loop.update({ where: { id: ids.loopId }, data: { status: "paused" } });

      expect(await startLoopRun(loaded)).toBe("skipped");
      expect(await runRow(run.id)).toMatchObject({
        status: "skipped_paused",
        startedAt: null,
      });
    });

    it("skips as blocked when a Free workspace used its loop runs", async () => {
      const ids = await setup({ plan: "free", loopBlocked: true });
      const run = await addRun(ids);
      await runJob(run.id);
      const after = await runRow(run.id);
      expect(after).toMatchObject({ status: "skipped_blocked", error: LOOP_PLAN_SKIP });
      expect(after.finishedAt).toBeInstanceOf(Date);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lets a paid workspace run whatever its loopBlocked says", async () => {
      const ids = await setup({ plan: "pro", loopBlocked: true });
      const run = await addRun(ids);
      await runJob(run.id);
      expect((await runRow(run.id)).status).toBe("quiet");
    });

    it("skips as blocked when the project hit its daily run cap", async () => {
      const ids = await setup();
      for (let i = 0; i < LOOP_LIMITS.runsPerProjectPerDay; i++) {
        await addRun(ids, { status: "quiet", withSession: true });
      }
      const run = await addRun(ids);
      await runJob(run.id);
      expect(await runRow(run.id)).toMatchObject({
        status: "skipped_blocked",
        error: LOOP_DAILY_CAP_SKIP,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("counts a running run toward the daily cap before it has its session", async () => {
      const ids = await setup();
      for (let i = 0; i < LOOP_LIMITS.runsPerProjectPerDay; i++) {
        await addRun(ids, { status: "running" });
      }
      const run = await addRun(ids);
      await runJob(run.id);
      expect(await runRow(run.id)).toMatchObject({
        status: "skipped_blocked",
        error: LOOP_DAILY_CAP_SKIP,
      });
    });

    it("does not count runs that failed before calling the agent toward the daily cap", async () => {
      const ids = await setup();
      for (let i = 0; i < LOOP_LIMITS.runsPerProjectPerDay; i++) {
        await addRun(ids, { status: "failed" });
      }
      const run = await addRun(ids);
      await runJob(run.id);
      expect((await runRow(run.id)).status).toBe("quiet");
    });
  });

  describe("the model", () => {
    it("fails a run whose BYOK provider is missing, without calling the agent", async () => {
      const ids = await setup({ loop: { model: "gpt-5", provider: "my-openai", source: "byok" } });
      const run = await addRun(ids, { trigger: "schedule" });
      mocks.resolveProjectModel.mockResolvedValue({ error: "BYOK provider is gone" });
      await runJob(run.id);
      const after = await runRow(run.id);
      expect(after).toMatchObject({ status: "failed", error: "BYOK provider is gone" });
      // Started, then failed with no session: it counts against neither the plan nor the cap.
      expect(after.startedAt).toBeInstanceOf(Date);
      expect(after.sessionId).toBeNull();
      expect(after.finishedAt).toBeInstanceOf(Date);
      // It still fails where the user sees it, on the failure streak.
      expect((await loopRow(ids.loopId)).failureStreak).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails the run, instead of leaving it running, when its model cannot be resolved", async () => {
      const ids = await setup({ loop: { model: "gpt-5", provider: "p", source: "system" } });
      const run = await addRun(ids);
      mocks.resolveProjectModel.mockRejectedValue(new Error("unknown adapter\nstack..."));
      await runJob(run.id);
      const after = await runRow(run.id);
      expect(after).toMatchObject({ status: "failed", error: "unknown adapter", sessionId: null });
      expect(after.finishedAt).toBeInstanceOf(Date);
      expect((await loopRow(ids.loopId)).lastRunAt).toBeInstanceOf(Date);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uses the loop's own model when it has one", async () => {
      const ids = await setup({
        loop: { model: "gpt-5", provider: "my-openai", source: "byok" },
        project: { rcaModel: "m", rcaProvider: "p", rcaSource: "system" },
      });
      await runJob((await addRun(ids)).id);
      expect(mocks.resolveProjectModel).toHaveBeenCalledWith(
        "gpt-5",
        "my-openai",
        "byok",
        ids.workspaceId,
      );
    });

    it("falls back to the project's Agent model when the loop has none", async () => {
      const ids = await setup({
        project: { rcaModel: "m", rcaProvider: "p", rcaSource: "system" },
      });
      await runJob((await addRun(ids)).id);
      expect(mocks.resolveProjectModel).toHaveBeenCalledWith("m", "p", "system", ids.workspaceId);
    });

    it("records the agent service's default model when neither the loop nor the project names one", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      mocks.resolveProjectModel.mockResolvedValue(null);
      agentAnswers({
        modelUsed: { model: "claude-opus-4-8", provider: "anthropic", source: "system" },
      });
      await runJob(run.id);

      // No model was sent: the agent picked its default, and said which.
      const runBody = JSON.parse(fetchMock.mock.calls[1]![1].body);
      expect(runBody).not.toHaveProperty("model");
      expect((await runRow(run.id)).metadata).toMatchObject({
        model: "claude-opus-4-8",
        provider: "anthropic",
        source: "system",
      });
    });

    it("records the model it asked for when the turn never started", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      agentAnswers({ status: "error", summary: null, error: "boom", modelUsed: null });
      await runJob(run.id);

      expect((await runRow(run.id)).metadata).toMatchObject({
        model: "claude-sonnet",
        provider: "anthropic",
        source: "system",
      });
    });
  });

  describe("the agent call", () => {
    it("creates the session, calls the loop-runs route and finishes quiet", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      await runJob(run.id);

      const [sessionUrl, sessionInit] = fetchMock.mock.calls[0]!;
      expect(sessionUrl).toMatch(new RegExp(`/api/v1/projects/${ids.projectId}/sessions$`));
      expect(JSON.parse(sessionInit.body)).toEqual({ title: `[Loop] Tool errors #${run.seq}` });
      const [runUrl, runInit] = fetchMock.mock.calls[1]!;
      expect(runUrl).toMatch(new RegExp(`/api/v1/projects/${ids.projectId}/loop-runs/${run.id}$`));
      expect(JSON.parse(runInit.body)).toEqual({
        sessionId: lastSessionId,
        model: "claude-sonnet",
        providerName: "anthropic",
        source: "system",
        deadlineMs: 20 * 60_000,
      });
      expect(runInit.signal).toBeInstanceOf(AbortSignal);

      const after = await runRow(run.id);
      expect(after).toMatchObject({
        status: "quiet",
        sessionId: lastSessionId,
        summary: "Nothing recurring in the last 24 hours.",
        tracesRead: 7,
        error: null,
        findingKeys: [],
        metadata: {
          model: "claude-sonnet",
          provider: "anthropic",
          source: "system",
          toolCalls: 12,
          agentStatus: "submitted",
        },
      });
      expect(Number(after.costUsd)).toBeCloseTo(0.42);
      expect(after.startedAt).toBeInstanceOf(Date);
      expect(after.finishedAt).toBeInstanceOf(Date);
      expect((await loopRow(ids.loopId)).lastRunAt).toBeInstanceOf(Date);
    });

    it("finishes timed_out when our own abort fires", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      fetchMock.mockImplementation(async (target: string) => {
        if (target.endsWith("/sessions")) return createSession(target);
        throw new DOMException("The operation timed out.", "TimeoutError");
      });
      await runJob(run.id);
      expect(await runRow(run.id)).toMatchObject({
        status: "timed_out",
        error: "The run did not finish within 20 minutes.",
      });
    });

    it("fails with a short public message on a non-2xx answer", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      fetchMock.mockImplementation(async (target: string) => {
        if (target.endsWith("/sessions")) return createSession(target);
        return new Response("Traceback (most recent call last):\n  secret", { status: 502 });
      });
      await runJob(run.id);
      expect(await runRow(run.id)).toMatchObject({
        status: "failed",
        error: "The agent service failed to run this loop (HTTP 502).",
      });
    });

    it("fails the run without calling the agent when its session cannot be created", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
      await runJob(run.id);
      expect(await runRow(run.id)).toMatchObject({
        status: "failed",
        error: "Failed to create the loop session: HTTP 503",
        sessionId: null,
      });
      expect(fetchMock.mock.calls.map(([target]) => String(target))).not.toContainEqual(
        expect.stringContaining("/loop-runs/"),
      );
    });

    it("gives the session create its own short timeout, and fails the run when it fires", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      // The session's timer fires at once; any other keeps its real length.
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) =>
          ms === LOOP_SESSION_TIMEOUT_MS
            ? AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"))
            : realTimeout(ms),
        );
      // A hung agent service: the request settles only when its signal aborts.
      fetchMock.mockImplementation(
        (_target: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal!;
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
      );

      await runJob(run.id);

      expect(timeout).toHaveBeenCalledWith(LOOP_SESSION_TIMEOUT_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await runRow(run.id)).toMatchObject({
        status: "failed",
        error: LOOP_SESSION_TIMEOUT_ERROR,
        sessionId: null,
      });
    });

    it("records the agent's outcome: a failed answer fails the run", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      agentAnswers({ status: "error", summary: null, error: "Provider refused\nstack..." });
      await runJob(run.id);
      expect(await runRow(run.id)).toMatchObject({ status: "failed", error: "Provider refused" });
    });
  });

  describe("an empty window", () => {
    it("skips the run without calling the agent", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      mocks.windowHasTraces.mockResolvedValue(false);
      await runJob(run.id);

      expect(mocks.windowHasTraces).toHaveBeenCalledWith(ids.projectId, 24);
      expect(fetchMock).not.toHaveBeenCalled();
      const after = await runRow(run.id);
      expect(after).toMatchObject({
        status: "skipped_no_traces",
        error: noTracesSkip(24),
        sessionId: null,
        summary: null,
      });
      expect(after.startedAt).toBeInstanceOf(Date);
      expect(after.finishedAt).toBeInstanceOf(Date);
      // It did not run: the Loop's last run stays as it was.
      expect((await loopRow(ids.loopId)).lastRunAt).toBeNull();
    });

    it("leaves a scheduled loop's failure streak alone", async () => {
      const ids = await setup({ loop: { failureStreak: LOOP_LIMITS.failureStreakToPause - 1 } });
      mocks.windowHasTraces.mockResolvedValue(false);
      for (let i = 0; i < 3; i++) {
        await runJob((await addRun(ids, { trigger: "schedule" })).id);
      }
      expect(await loopRow(ids.loopId)).toMatchObject({
        failureStreak: LOOP_LIMITS.failureStreakToPause - 1,
        status: "active",
      });
    });

    it("does not count toward the daily cap", async () => {
      const ids = await setup();
      for (let i = 0; i < LOOP_LIMITS.runsPerProjectPerDay; i++) {
        await addRun(ids, { status: "skipped_no_traces" });
      }
      const run = await addRun(ids);
      await runJob(run.id);
      expect((await runRow(run.id)).status).toBe("quiet");
    });

    it("still fails a run whose model cannot be resolved", async () => {
      const ids = await setup({ loop: { model: "gpt-5", provider: "my-openai", source: "byok" } });
      mocks.resolveProjectModel.mockResolvedValue({ error: "BYOK provider is gone" });
      mocks.windowHasTraces.mockResolvedValue(false);
      const run = await addRun(ids, { trigger: "schedule" });
      await runJob(run.id);
      expect((await runRow(run.id)).status).toBe("failed");
      expect(mocks.windowHasTraces).not.toHaveBeenCalled();
    });

    it("calls the agent when the check itself fails", async () => {
      const ids = await setup();
      const run = await addRun(ids);
      mocks.windowHasTraces.mockRejectedValue(new Error("Backend down"));
      await runJob(run.id);
      expect((await runRow(run.id)).status).toBe("quiet");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("failure streak", () => {
    it("pauses a loop after five failed scheduled runs", async () => {
      const ids = await setup();
      agentAnswers({ status: "no_summary", summary: null });
      for (let i = 1; i <= LOOP_LIMITS.failureStreakToPause; i++) {
        await runJob((await addRun(ids, { trigger: "schedule" })).id);
        const loop = await loopRow(ids.loopId);
        expect(loop.failureStreak).toBe(i);
        expect(loop.status).toBe(
          i < LOOP_LIMITS.failureStreakToPause ? "active" : "paused_by_system",
        );
      }
    });

    it("does not count manual failures, and a quiet scheduled run resets it", async () => {
      const ids = await setup({ loop: { failureStreak: 4 } });
      agentAnswers({ status: "no_summary", summary: null });
      await runJob((await addRun(ids, { trigger: "manual" })).id);
      expect(await loopRow(ids.loopId)).toMatchObject({ failureStreak: 4, status: "active" });

      agentAnswers({});
      await runJob((await addRun(ids, { trigger: "schedule" })).id);
      expect((await loopRow(ids.loopId)).failureStreak).toBe(0);
    });
  });
});
