/**
 * Per-case run history (CasePanel "Runs" tab): every evaluation run that measured this
 * stable testCaseId, flattened into one row per result. The query is keyed by project +
 * testCaseId — the dataset in the path is scoping only, so history survives the case
 * moving between dataset versions. Auth + Prisma are mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const prismaMock = vi.hoisted(() => ({
  evaluationResult: { findMany: vi.fn(), groupBy: vi.fn() },
}));
const auth = vi.hoisted(() => ({ requireAuth: vi.fn(), requireProjectAccess: vi.fn() }));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return { ...actual, prisma: prismaMock };
});
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

const params = {
  params: Promise.resolve({ projectId: "p1", datasetId: "ds1", testCaseId: "case-1" }),
};

function resultRow(over: Record<string, unknown> = {}) {
  return {
    id: "res_1",

    status: "passed",
    change: "improved",
    createTime: new Date("2026-07-21T00:00:10Z"),
    run: {
      id: "run_2",
      runNumber: 2,
      candidateVersion: "sonnet",
      startedAt: new Date("2026-07-21T00:00:00Z"),
      datasetVersionId: "dv1",
      caseCount: 3,
      datasetCaseCount: 10,
      selectionMode: "first",
      selectedCaseCount: 3,
      sampleSeed: null,
      evaluation: { name: "ticket-routing" },
    },
    ...over,
  };
}

async function rows(res: { json: () => Promise<unknown> }) {
  return ((await res.json()) as { data: Record<string, unknown>[] }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.evaluationResult.groupBy.mockResolvedValue([]);
});

it("flattens each result into a run row with the run's identity, version, score and run-level totals", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([resultRow()]);
  // Run-level totals summed over all of run_2's cases (not just this one).
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    { runId: "run_2", _sum: { cost: 0.03, durationMs: 1500 }, _count: { cost: 3, durationMs: 3 } },
  ]);

  const res = await GET({} as never, params);
  expect(res.status).toBe(200);
  expect((await rows(res))[0]).toEqual({
    resultId: "res_1",
    runId: "run_2",
    runNumber: 2,
    candidateVersion: "sonnet",
    evaluationName: "ticket-routing",
    datasetVersionId: "dv1",
    ranAt: "2026-07-21T00:00:00.000Z",
    status: "passed",
    change: "improved",
    caseCount: 3,
    coverage: { mode: "first", datasetCaseCount: 10, selectedCaseCount: 3, sampleSeed: null },
    cost: 0.03,
    elapsedMs: 1500,
    avgCost: 0.01,
    avgDurationMs: 500,
    costObservedCount: 3,
    durationObservedCount: 3,
  });
});

it("averages over the run's results that reported each value, not its declared case count", async () => {
  // Declared 500 (a `--first 3` that sent no case_count), three results, one with no cost.
  prismaMock.evaluationResult.findMany.mockResolvedValue([
    resultRow({ run: { ...resultRow().run, caseCount: 500 } }),
  ]);
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    { runId: "run_2", _sum: { cost: 0.04, durationMs: 1500 }, _count: { cost: 2, durationMs: 3 } },
  ]);

  const row = (await rows(await GET({} as never, params)))[0];
  expect(row.avgCost).toBeCloseTo(0.02);
  expect(row.avgDurationMs).toBe(500);
  expect(row.costObservedCount).toBe(2);
  expect(row.durationObservedCount).toBe(3);
});

it("serves null averages when the run has no aggregate yet", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([resultRow()]);
  const row = (await rows(await GET({} as never, params)))[0];
  expect(row.avgCost).toBeNull();
  expect(row.avgDurationMs).toBeNull();
  expect(row.costObservedCount).toBe(0);
  expect(row.durationObservedCount).toBe(0);
});

it("reads a run that reported no selection as coverage unknown, never as full", async () => {
  // Every row written before coverage existed looks like this. The panel must not
  // imply the run measured the whole dataset just because nothing said otherwise.
  prismaMock.evaluationResult.findMany.mockResolvedValue([
    resultRow({
      run: {
        ...resultRow().run,
        datasetCaseCount: null,
        selectionMode: null,
        selectedCaseCount: null,
        sampleSeed: null,
      },
    }),
  ]);

  const res = await GET({} as never, params);
  expect((await rows(res))[0].coverage).toEqual({
    mode: "unknown",
    datasetCaseCount: null,
    selectedCaseCount: null,
    sampleSeed: null,
  });
});

it("queries by project + stable testCaseId, scoped to this dataset, newest first", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);
  await GET({} as never, params);

  const args = prismaMock.evaluationResult.findMany.mock.calls[0][0];
  // A stable testCaseId is only unique within a dataset lineage, and this route is
  // mounted under a specific datasetId — so results are scoped through the run's
  // dataset, never surfacing runs from another dataset that reused the id.
  expect(args.where).toEqual({ projectId: "p1", testCaseId: "case-1", run: { datasetId: "ds1" } });
  expect(args.orderBy).toEqual({ createTime: "desc" });
});

it("returns an empty list for a case no run has measured", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);
  expect(await rows(await GET({} as never, params))).toEqual([]);
});

it("passes through an unscored result's null change", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([
    resultRow({ status: "not_scored", change: null }),
  ]);
  const row = (await rows(await GET({} as never, params)))[0];
  expect(row.change).toBeNull();
  expect(row.status).toBe("not_scored");
});

it("401s an unauthenticated caller before touching the database", async () => {
  auth.requireAuth.mockResolvedValue({
    error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
  });
  expect((await GET({} as never, params)).status).toBe(401);
  expect(prismaMock.evaluationResult.findMany).not.toHaveBeenCalled();
});

it("403s a caller without project access", async () => {
  auth.requireProjectAccess.mockResolvedValue({
    error: { status: 403, json: async () => ({ error: "Forbidden" }) },
  });
  expect((await GET({} as never, params)).status).toBe(403);
  expect(prismaMock.evaluationResult.findMany).not.toHaveBeenCalled();
});
