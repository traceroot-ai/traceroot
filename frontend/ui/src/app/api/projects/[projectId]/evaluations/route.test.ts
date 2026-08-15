/**
 * Evaluation-lineage list: each stable evaluation with its run count and latest run,
 * plus the dataset NAME resolved in one batched query (never one lookup per lineage)
 * and scoped to the project so a stale datasetId reads as null. Auth + Prisma mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluation: { findMany: vi.fn() },
  dataset: { findMany: vi.fn() },
  // Each lineage carries an aggregate row derived at read time (average score over
  // the runs that were actually scored, plus summed cost/duration over its results).
  evaluationRun: { groupBy: vi.fn(), findMany: vi.fn() },
  evaluationResult: { groupBy: vi.fn() },
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

const params = { params: Promise.resolve({ projectId: "p1" }) };

function evaluation(over: Record<string, unknown> = {}) {
  return {
    id: "eval_1",
    projectId: "p1",
    name: "ticket-routing",
    datasetId: "ds1",
    _count: { runs: 4 },
    runs: [
      {
        id: "run_4",
        runNumber: 4,
        candidateVersion: "sonnet",
        status: "completed",
        mainScore: 0.75,
        startedAt: new Date("2026-07-21T00:00:00Z"),
        datasetVersionId: "dv2",
      },
    ],
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
  prismaMock.dataset.findMany.mockResolvedValue([{ id: "ds1", name: "support" }]);
  // No aggregate rows unless a case sets them: a lineage with no scored run reports
  // nulls rather than a fabricated zero.
  prismaMock.evaluationRun.groupBy.mockResolvedValue([]);
  prismaMock.evaluationRun.findMany.mockResolvedValue([]);
  prismaMock.evaluationResult.groupBy.mockResolvedValue([]);
});

it("returns each lineage with its dataset name, run count, and latest run", async () => {
  prismaMock.evaluation.findMany.mockResolvedValue([evaluation()]);

  const res = await GET({} as never, params);
  expect(res.status).toBe(200);
  const row = (await rows(res))[0];
  expect(row).toMatchObject({ id: "eval_1", datasetName: "support", runCount: 4 });
  expect(row.latestRun).toMatchObject({ id: "run_4", runNumber: 4 });
});

it("reports a null latest run for a lineage that has never run", async () => {
  prismaMock.evaluation.findMany.mockResolvedValue([evaluation({ runs: [], _count: { runs: 0 } })]);
  const row = (await rows(await GET({} as never, params)))[0];
  expect(row.latestRun).toBeNull();
  expect(row.runCount).toBe(0);
});

it("resolves every distinct dataset in a single batched query", async () => {
  prismaMock.evaluation.findMany.mockResolvedValue([
    evaluation(),
    evaluation({ id: "eval_2" }), // same dataset — must not add a query or a duplicate id
    evaluation({ id: "eval_3", datasetId: "ds2" }),
  ]);
  prismaMock.dataset.findMany.mockResolvedValue([
    { id: "ds1", name: "support" },
    { id: "ds2", name: "billing" },
  ]);

  const data = await rows(await GET({} as never, params));
  expect(data.map((r) => r.datasetName)).toEqual(["support", "support", "billing"]);
  expect(prismaMock.dataset.findMany).toHaveBeenCalledTimes(1);
  expect(prismaMock.dataset.findMany.mock.calls[0][0].where).toEqual({
    id: { in: ["ds1", "ds2"] },
    projectId: "p1",
  });
});

it("reports a null dataset name when the dataset is missing from this project", async () => {
  prismaMock.evaluation.findMany.mockResolvedValue([evaluation({ datasetId: "ds_gone" })]);
  prismaMock.dataset.findMany.mockResolvedValue([]);
  expect((await rows(await GET({} as never, params)))[0].datasetName).toBeNull();
});

it("returns an empty list and skips the dataset query when there are no lineages", async () => {
  prismaMock.evaluation.findMany.mockResolvedValue([]);
  expect(await rows(await GET({} as never, params))).toEqual([]);
  expect(prismaMock.dataset.findMany).not.toHaveBeenCalled();
});

it("401s an unauthenticated caller before touching the database", async () => {
  auth.requireAuth.mockResolvedValue({
    error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
  });
  expect((await GET({} as never, params)).status).toBe(401);
  expect(prismaMock.evaluation.findMany).not.toHaveBeenCalled();
});

it("403s a caller without project access", async () => {
  auth.requireProjectAccess.mockResolvedValue({
    error: { status: 403, json: async () => ({ error: "Forbidden" }) },
  });
  expect((await GET({} as never, params)).status).toBe(403);
  expect(prismaMock.evaluation.findMany).not.toHaveBeenCalled();
});

it("sums each case's duration for the lineage duration total", async () => {
  prismaMock.evaluation.findMany.mockResolvedValue([evaluation()]);
  // Duration is the sum of every case's duration across the lineage's runs (120s here),
  // so the lineage total adds up to the per-case rows — never run wall-clock.
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    { evaluationId: "eval_1", _sum: { durationMs: 120_000, cost: null } },
  ]);

  const [row] = await rows(await GET({} as never, params));
  expect((row.aggregate as { totalDurationMs: number | null }).totalDurationMs).toBe(120_000);
});

it("reports a null lineage duration when no case reported one", async () => {
  prismaMock.evaluation.findMany.mockResolvedValue([evaluation()]);
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    { evaluationId: "eval_1", _sum: { durationMs: null, cost: null } },
  ]);

  const [row] = await rows(await GET({} as never, params));
  expect((row.aggregate as { totalDurationMs: number | null }).totalDurationMs).toBeNull();
});
