/**
 * Per-case run history (CasePanel "Runs" tab): every evaluation run that measured this
 * stable testCaseId, flattened into one row per result. The query is keyed by project +
 * testCaseId — the dataset in the path is scoping only, so history survives the case
 * moving between dataset versions. Auth + Prisma are mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationResult: { findMany: vi.fn() },
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
});

it("flattens each result into a run row with the run's identity and this case's score", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([resultRow()]);

  const res = await GET({} as never, params);
  expect(res.status).toBe(200);
  expect((await rows(res))[0]).toEqual({
    resultId: "res_1",
    runId: "run_2",
    runNumber: 2,
    candidateVersion: "sonnet",
    evaluationName: "ticket-routing",
    ranAt: "2026-07-21T00:00:00.000Z",
    score: 1,
    status: "passed",
    change: "improved",
  });
});

it("queries by project + stable testCaseId (not the dataset), newest first", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);
  await GET({} as never, params);

  const args = prismaMock.evaluationResult.findMany.mock.calls[0][0];
  expect(args.where).toEqual({ projectId: "p1", testCaseId: "case-1" });
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
