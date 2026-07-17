/**
 * Run-list derivation: the list exposes a restrained comparison summary
 * (regressedCaseCount + trustworthy scalar delta + elapsedMs) from the SAME engine as
 * run detail, batched (baseline runs + all results) so a page is a bounded number of
 * queries, never a per-row N+1.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationRun: { findMany: vi.fn(), count: vi.fn() },
  dataset: { findMany: vi.fn() },
  evaluationResult: { findMany: vi.fn() },
  $transaction: vi.fn(async (arr: Promise<unknown>[]) => Promise.all(arr)),
}));
const auth = vi.hoisted(() => ({ requireAuth: vi.fn(), requireProjectAccess: vi.fn() }));

vi.mock("@traceroot/core", () => ({ prisma: prismaMock }));
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

const nextUrl = (qs = "") => ({ nextUrl: { searchParams: new URLSearchParams(qs) } });
const params = { params: Promise.resolve({ projectId: "p1" }) };

function score(name: string, numericValue: number) {
  return {
    scorerName: name,
    scorerVersion: "unversioned",
    numericValue,
    boolValue: null,
    stringValue: null,
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.$transaction.mockImplementation(async (arr: Promise<unknown>[]) => Promise.all(arr));
  prismaMock.dataset.findMany.mockResolvedValue([{ id: "ds1", name: "support" }]);
});

it("derives regressedCaseCount + trustworthy delta + elapsedMs for a listed run", async () => {
  const candidate = {
    id: "run_c",
    projectId: "p1",
    evaluationId: "e1",
    datasetId: "ds1",
    datasetVersionId: "dv1",
    runNumber: 2,
    candidateVersion: "sonnet",
    status: "completed",
    baselineRunId: "run_b",
    mainScore: 0.5,
    mainScoreName: "acc",
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [{ name: "acc", version: "unversioned" }],
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: new Date("2026-07-21T00:00:05Z"),
    evaluation: { name: "ticket-routing" },
    datasetVersion: { label: "v1" },
  };
  const baselineRun = {
    id: "run_b",
    projectId: "p1",
    evaluationId: "e1",
    datasetId: "ds1",
    datasetVersionId: "dv1",
    runNumber: 1,
    candidateVersion: "opus",
    status: "completed",
    baselineRunId: null,
    mainScore: 1,
    mainScoreName: "acc",
    scorers: [{ name: "acc", version: "unversioned" }],
  };

  prismaMock.evaluationRun.findMany
    .mockResolvedValueOnce([candidate]) // page runs
    .mockResolvedValueOnce([baselineRun]); // baselines
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([
    {
      runId: "run_c",
      testCaseId: "t0",
      status: "passed",
      mainScore: 1,
      candidateOutput: "billing",
      durationMs: 900,
      scores: [score("acc", 1)],
    },
    {
      runId: "run_c",
      testCaseId: "t5",
      status: "passed",
      mainScore: 0,
      candidateOutput: "general",
      durationMs: 950,
      scores: [score("acc", 0)],
    },
    {
      runId: "run_b",
      testCaseId: "t0",
      status: "passed",
      mainScore: 1,
      candidateOutput: "billing",
      durationMs: 800,
      scores: [score("acc", 1)],
    },
    {
      runId: "run_b",
      testCaseId: "t5",
      status: "passed",
      mainScore: 1,
      candidateOutput: "technical",
      durationMs: 850,
      scores: [score("acc", 1)],
    },
  ]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  const row = body.data[0];
  expect(row.regressedCaseCount).toBe(1);
  expect(row.changeFromBaseline).toBeCloseTo(-0.5);
  expect(row.baselineComparable).toBe(true);
  expect(row.elapsedMs).toBe(5000);
  // Bounded: one page-runs query + one baselines query + one results query (+ datasets).
  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledTimes(2);
  expect(prismaMock.evaluationResult.findMany).toHaveBeenCalledTimes(1);
});

it("shows null comparison fields for a run with no baseline", async () => {
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([
    {
      id: "run_solo",
      projectId: "p1",
      evaluationId: "e1",
      datasetId: "ds1",
      datasetVersionId: "dv1",
      runNumber: 1,
      candidateVersion: "opus",
      status: "completed",
      baselineRunId: null,
      mainScore: 1,
      mainScoreName: "acc",
      taskErrorCount: 0,
      scorerErrorCount: 0,
      scorers: [],
      startedAt: new Date("2026-07-21T00:00:00Z"),
      completedAt: null,
      evaluation: { name: "e" },
      datasetVersion: { label: "v1" },
    },
  ]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  const row = body.data[0];
  expect(row.changeFromBaseline).toBeNull();
  expect(row.regressedCaseCount).toBeNull();
  expect(row.baselineComparable).toBe(false);
  expect(row.elapsedMs).toBeNull();
  // No baseline ids → the baselines findMany is skipped (only the page-runs query ran).
  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledTimes(1);
});

it("derives per-status counts for a listed run", async () => {
  const run = {
    id: "run_c",
    projectId: "p1",
    evaluationId: "e1",
    datasetId: "ds1",
    datasetVersionId: "dv1",
    runNumber: 2,
    candidateVersion: "sonnet",
    status: "completed",
    baselineRunId: null,
    mainScore: 0.5,
    mainScoreName: "acc",
    taskErrorCount: 1,
    scorerErrorCount: 0,
    scorers: [{ name: "acc", version: "unversioned" }],
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: new Date("2026-07-21T00:00:05Z"),
    evaluation: { name: "ticket-routing" },
    datasetVersion: { label: "v1" },
  };
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([run]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([
    { runId: "run_c", testCaseId: "t0", status: "passed", mainScore: 1, scores: [] },
    { runId: "run_c", testCaseId: "t1", status: "passed", mainScore: 1, scores: [] },
    { runId: "run_c", testCaseId: "t2", status: "failed", mainScore: 0, scores: [] },
    { runId: "run_c", testCaseId: "t3", status: "errored", mainScore: null, scores: [] },
    { runId: "run_c", testCaseId: "t4", status: "not_scored", mainScore: null, scores: [] },
  ]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  expect(body.data[0].passedCount).toBe(2);
  expect(body.data[0].failedCount).toBe(1);
  expect(body.data[0].erroredCount).toBe(1);
  expect(body.data[0].notScoredCount).toBe(1);
});

it("reports zero counts for a run with no results, without extra queries", async () => {
  const run = {
    id: "run_empty",
    projectId: "p1",
    evaluationId: "e1",
    datasetId: "ds1",
    datasetVersionId: "dv1",
    runNumber: 1,
    candidateVersion: "sonnet",
    status: "running",
    baselineRunId: null,
    mainScore: null,
    mainScoreName: "acc",
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [],
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: null,
    evaluation: { name: "ticket-routing" },
    datasetVersion: { label: "v1" },
  };
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([run]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  expect(body.data[0].passedCount).toBe(0);
  expect(body.data[0].failedCount).toBe(0);
  // Still exactly one results query — the counts add no round trips.
  expect(prismaMock.evaluationResult.findMany).toHaveBeenCalledTimes(1);
});

it("prefers the derived counts over a stored scoredCount that disagrees", async () => {
  // scoredCount says 9, the result rows say 2 judged. The rows win: numerator and
  // denominator must come from the same source or the fraction can exceed 1.
  const run = {
    id: "run_c",
    projectId: "p1",
    evaluationId: "e1",
    datasetId: "ds1",
    datasetVersionId: "dv1",
    runNumber: 3,
    candidateVersion: "sonnet",
    status: "completed",
    baselineRunId: null,
    mainScore: 0.5,
    mainScoreName: "acc",
    caseCount: 9,
    scoredCount: 9,
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [{ name: "acc", version: "unversioned" }],
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: new Date("2026-07-21T00:00:05Z"),
    evaluation: { name: "ticket-routing" },
    datasetVersion: { label: "v1" },
  };
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([run]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([
    { runId: "run_c", testCaseId: "t0", status: "passed", mainScore: 1, scores: [] },
    { runId: "run_c", testCaseId: "t1", status: "failed", mainScore: 0, scores: [] },
  ]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  expect(body.data[0].passedCount).toBe(1);
  expect(body.data[0].failedCount).toBe(1);
  // The stored counter is passed through untouched — it is not reconciled in v1.
  expect(body.data[0].scoredCount).toBe(9);
});
