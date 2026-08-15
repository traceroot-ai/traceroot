/**
 * Per-case run history (CasePanel "Runs" tab): every evaluation run that measured this
 * stable testCaseId, flattened into one row per result. The query is keyed by project +
 * testCaseId — the dataset in the path is scoping only, so history survives the case
 * moving between dataset versions. Auth + Prisma are mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

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
    mainScore: 1,
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
    { runId: "run_2", _sum: { cost: 0.03, durationMs: 1500 } },
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
    score: 1,
    status: "passed",
    change: "improved",
    caseCount: 3,
    cost: 0.03,
    elapsedMs: 1500,
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

it("passes through an unscored result's null score and null change", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([
    resultRow({ mainScore: null, status: "not_scored", change: null }),
  ]);
  const row = (await rows(await GET({} as never, params)))[0];
  expect(row.score).toBeNull();
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
