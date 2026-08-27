/**
 * Retention gate on the by-id run read.
 *
 * A list has a window to pull forward, so it clamps silently; a by-id read has none, so
 * it refuses with 403 — the split `clamp_retention_window` / `enforce_retention_by_time`
 * already draws in backend/rest/retention.py. These cases pin that refusal across the
 * plan table, the fail-closed paths, the one-hour boundary buffer, and the comparison
 * page (which reads each of its runs through this route).
 *
 * Auth + Prisma are mocked; `@traceroot/core` is spread from the real module so the
 * plan table and `getRetentionDays` are the shipped ones, not a second copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationRun: { findFirst: vi.fn() },
  dataset: { findFirst: vi.fn() },
  evaluationResult: { groupBy: vi.fn(), aggregate: vi.fn() },
  workspace: { findUnique: vi.fn() },
}));
const auth = vi.hoisted(() => ({ requireAuth: vi.fn(), requireProjectAccess: vi.fn() }));

vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: prismaMock,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: auth.requireAuth,
  requireProjectAccess: auth.requireProjectAccess,
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));

import { GET } from "./route";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const agoMs = (ms: number) => new Date(Date.now() - ms);
const daysAgo = (days: number) => agoMs(days * DAY_MS);

const params = (runId = "run-1") => ({ params: Promise.resolve({ projectId: "p1", runId }) });

/** A minimal, baseline-free run — only `startedAt` matters to the gate. */
function run(startedAt: Date, id = "run-1") {
  return {
    id,
    projectId: "p1",
    evaluationId: "eval-1",
    datasetId: "ds1",
    datasetVersionId: "dv1",
    runNumber: 1,
    candidateVersion: "sonnet",
    status: "completed",
    baselineRunId: null,
    caseCount: 0,
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [],
    startedAt,
    completedAt: startedAt,
    evaluation: { name: "Billing routing" },
    datasetVersion: { label: "v1" },
    baselineRun: null,
    results: [],
  };
}

/** Drive the route for a run started `startedAt` on a workspace holding `plan`. */
async function read(plan: string | null, startedAt: Date, runId = "run-1") {
  prismaMock.evaluationRun.findFirst.mockResolvedValue(run(startedAt, runId));
  prismaMock.workspace.findUnique.mockResolvedValue(plan === null ? null : { billingPlan: plan });
  return GET({} as never, params(runId));
}

beforeEach(() => {
  prismaMock.evaluationRun.findFirst.mockReset();
  prismaMock.dataset.findFirst.mockReset();
  prismaMock.evaluationResult.groupBy.mockReset();
  prismaMock.evaluationResult.aggregate.mockReset();
  prismaMock.workspace.findUnique.mockReset();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1", workspaceId: "ws1" } });
  prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1", name: "Billing routing" });
  prismaMock.evaluationResult.groupBy.mockResolvedValue([]);
  prismaMock.evaluationResult.aggregate.mockResolvedValue({
    _sum: { durationMs: null, cost: null },
  });
});

describe("by-id run read, outside the window", () => {
  it("refuses with 403 rather than returning the run", async () => {
    const res = await read("free", daysAgo(40));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Data outside retention window" });
  });

  it("does no further reading once it has refused", async () => {
    await read("free", daysAgo(40));
    // The baseline lookup shares evaluationRun.findFirst with the candidate: exactly
    // one call means the refusal landed before the rest of the detail assembly.
    expect(prismaMock.evaluationRun.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.dataset.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.evaluationResult.groupBy).not.toHaveBeenCalled();
    expect(prismaMock.evaluationResult.aggregate).not.toHaveBeenCalled();
  });

  it("resolves the plan from the workspace the project belongs to", async () => {
    await read("free", daysAgo(40));
    expect(prismaMock.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: "ws1" },
      select: { billingPlan: true },
    });
  });
});

describe("across the plan table", () => {
  it("returns the run untouched on the free plan", async () => {
    const res = await read("free", daysAgo(2));
    expect(res.status).toBe(200);
    expect((await res.json()).run.id).toBe("run-1");
  });

  it.each([
    ["starter", 20],
    ["pro", 60],
  ])("returns a run inside the %s window (%i days old)", async (plan, age) => {
    const res = await read(plan, daysAgo(age));
    expect(res.status).toBe(200);
  });

  it.each([
    ["starter", 40],
    ["pro", 120],
  ])("refuses a run outside the %s window (%i days old)", async (plan, age) => {
    const res = await read(plan, daysAgo(age));
    expect(res.status).toBe(403);
  });
});

describe("unlimited retention", () => {
  it("returns a five-year-old run on the enterprise plan", async () => {
    const res = await read("enterprise", daysAgo(5 * 365));
    expect(res.status).toBe(200);
  });
});

describe("fail closed", () => {
  it("treats an unrecognized plan string as the most restrictive window", async () => {
    // 20 days is inside starter/pro but outside free — so a plan the table does not
    // know must refuse, not wave the run through.
    const res = await read("legacy-team-plan", daysAgo(20));
    expect(res.status).toBe(403);
  });

  it("treats a missing workspace row as the most restrictive window", async () => {
    const res = await read(null, daysAgo(40));
    expect(res.status).toBe(403);
  });
});

describe("the boundary buffer", () => {
  it("keeps a run just past the raw cutoff readable (one-hour buffer)", async () => {
    const res = await read("free", agoMs(15 * DAY_MS + 30 * 60_000));
    expect(res.status).toBe(200);
  });

  it("refuses once the run is past the buffer too", async () => {
    const res = await read("free", agoMs(15 * DAY_MS + 2 * HOUR_MS));
    expect(res.status).toBe(403);
  });
});

describe("what the gate does not change", () => {
  it("keeps a missing run a 404, without resolving the plan", async () => {
    prismaMock.evaluationRun.findFirst.mockResolvedValue(null);
    const res = await GET({} as never, params("nope"));
    expect(res.status).toBe(404);
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("leaves auth and project access ahead of it", async () => {
    auth.requireProjectAccess.mockResolvedValue({ error: { status: 403 } });
    prismaMock.evaluationRun.findFirst.mockResolvedValue(run(daysAgo(1)));
    await GET({} as never, params());
    expect(prismaMock.evaluationRun.findFirst).not.toHaveBeenCalled();
  });
});

describe("the comparison page", () => {
  // The compare route has no server route of its own: it fetches each selected run
  // through this handler (see useEvaluationRunDetails). So a comparison mixing an
  // in-window run with an out-of-window one gets the run for the first and a refusal
  // for the second — the column cannot be filled by picking an older id by hand.
  it("refuses the out-of-window member of a comparison and serves the rest", async () => {
    const fresh = await read("free", daysAgo(3), "run-new");
    expect(fresh.status).toBe(200);

    const stale = await read("free", daysAgo(200), "run-old");
    expect(stale.status).toBe(403);
  });
});
