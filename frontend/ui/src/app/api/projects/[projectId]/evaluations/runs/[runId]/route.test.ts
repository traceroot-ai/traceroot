/**
 * Run-detail derivation: the read path derives candidate-vs-baseline comparison from
 * the two runs' raw results/scores (never the stored change/baselineOutput columns),
 * exposing a `comparison` block and per-result comparison. A back-compat scalar delta
 * is null unless the comparison is trustworthy, so the UI never subtracts incompatible
 * numbers. Auth + Prisma are mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationRun: { findFirst: vi.fn() },
  dataset: { findFirst: vi.fn() },
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

const params = { params: Promise.resolve({ projectId: "p1", runId: "run-1" }) };

function score(name: string, numericValue: number | null, error: string | null = null) {
  return {
    scorerName: name,
    scorerVersion: "unversioned",
    numericValue,
    boolValue: null,
    stringValue: null,
    error,
  };
}

/** A candidate run with two cases, main scorer `acc`; one case regresses vs baseline. */
function candidate(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    projectId: "p1",
    evaluationId: "eval-1",
    datasetId: "ds1",
    datasetVersionId: "dv2",
    runNumber: 2,
    candidateVersion: "sonnet",
    status: "completed",
    baselineRunId: "run-0",
    mainScore: 0.5,
    mainScoreName: "acc",
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [{ name: "acc", version: "unversioned" }],
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: new Date("2026-07-21T00:00:04Z"),
    evaluation: { name: "Billing routing" },
    datasetVersion: { label: "v2" },
    baselineRun: {
      id: "run-0",
      runNumber: 1,
      candidateVersion: "opus",
      mainScore: 1,
      evaluationId: "eval-1",
      datasetVersionId: "dv2",
      datasetVersion: { label: "v2" },
    },
    results: [
      {
        id: "r_a",
        testCaseId: "t0",
        traceId: "tr_a",
        input: "a",
        expectedOutput: "billing",
        candidateOutput: "billing",
        status: "passed",
        mainScore: 1,
        change: "improved",
        baselineOutput: "STORED-IGNORED",
        taskError: null,
        durationMs: 900,
        cost: null,
        scores: [score("acc", 1)],
        humanScores: [],
      },
      {
        id: "r_b",
        testCaseId: "t5",
        traceId: "tr_b",
        input: "b",
        expectedOutput: "technical",
        candidateOutput: "general",
        status: "passed",
        mainScore: 0,
        change: "unchanged",
        baselineOutput: null,
        taskError: null,
        durationMs: 1000,
        cost: null,
        scores: [score("acc", 0)],
        humanScores: [],
      },
    ],
    ...over,
  };
}

function baseline(over: Record<string, unknown> = {}) {
  return {
    id: "run-0",
    projectId: "p1",
    evaluationId: "eval-1",
    datasetId: "ds1",
    datasetVersionId: "dv2",
    runNumber: 1,
    candidateVersion: "opus",
    status: "completed",
    baselineRunId: null,
    mainScore: 1,
    mainScoreName: "acc",
    scorers: [{ name: "acc", version: "unversioned" }],
    results: [
      {
        testCaseId: "t0",
        status: "passed",
        mainScore: 1,
        candidateOutput: "billing",
        durationMs: 800,
        scores: [score("acc", 1)],
      },
      {
        testCaseId: "t5",
        status: "passed",
        mainScore: 1,
        candidateOutput: "technical",
        durationMs: 850,
        scores: [score("acc", 1)],
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  prismaMock.evaluationRun.findFirst.mockReset();
  prismaMock.dataset.findFirst.mockReset();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1", name: "Billing routing" });
});

it("derives change/baselineOutput + a comparison block from raw scores; ignores stored columns", async () => {
  prismaMock.evaluationRun.findFirst
    .mockResolvedValueOnce(candidate())
    .mockResolvedValueOnce(baseline());
  const body = (await (await GET({} as never, params)).json()) as {
    run: Record<string, unknown>;
    results: Record<string, unknown>[];
  };

  const cmp = body.run.comparison as Record<string, unknown>;
  expect(cmp.available).toBe(true);
  expect(cmp.trustworthy).toBe(true);
  expect((cmp.mainScore as { delta: number }).delta).toBeCloseTo(-0.5);
  expect(cmp.caseCounts).toMatchObject({ regressed: 1, unchanged: 1 });
  expect(body.run.changeFromBaseline).toBeCloseTo(-0.5);
  expect(body.run.baselineComparable).toBe(true);
  expect(body.run.elapsedMs).toBe(4000);

  const t0 = body.results.find((r) => r.testCaseId === "t0")!;
  expect(t0.change).toBe("unchanged");
  expect(t0.baselineOutput).toBe("billing"); // derived, NOT the stored "STORED-IGNORED"
  const t5 = body.results.find((r) => r.testCaseId === "t5")!;
  expect(t5.change).toBe("regressed"); // stored said "unchanged"
  expect((t5.comparison as { regressedCellCount: number }).regressedCellCount).toBe(1);
});

it("refuses a scalar delta when the baseline used a different dataset snapshot", async () => {
  prismaMock.evaluationRun.findFirst
    .mockResolvedValueOnce(candidate())
    .mockResolvedValueOnce(baseline({ datasetVersionId: "dv1" }));
  const body = (await (await GET({} as never, params)).json()) as { run: Record<string, unknown> };
  expect(body.run.baselineComparable).toBe(false);
  expect(body.run.changeFromBaseline).toBeNull();
  expect((body.run.comparison as { reasons: string[] }).reasons).toContain(
    "different_dataset_version",
  );
});

it("reports no baseline when none is linked", async () => {
  prismaMock.evaluationRun.findFirst.mockResolvedValueOnce(
    candidate({ baselineRunId: null, baselineRun: null }),
  );
  const body = (await (await GET({} as never, params)).json()) as { run: Record<string, unknown> };
  expect(body.run.baselineComparable).toBe(false);
  expect(body.run.changeFromBaseline).toBeNull();
  expect((body.run.comparison as { reasons: string[] }).reasons).toEqual(["no_baseline"]);
});

it("404s an unknown run", async () => {
  prismaMock.evaluationRun.findFirst.mockResolvedValueOnce(null);
  const res = await GET({} as never, params);
  expect(res.status).toBe(404);
});

it("derives per-status counts from the run's own results", async () => {
  // baselineRunId: null keeps this to a single findFirst — no baseline fetch.
  prismaMock.evaluationRun.findFirst.mockResolvedValueOnce(
    candidate({
      baselineRunId: null,
      results: [
        { id: "r1", testCaseId: "t0", status: "passed", mainScore: 1, scores: [], humanScores: [] },
        { id: "r2", testCaseId: "t1", status: "failed", mainScore: 0, scores: [], humanScores: [] },
        {
          id: "r3",
          testCaseId: "t2",
          status: "errored",
          mainScore: null,
          scores: [],
          humanScores: [],
        },
      ],
    }),
  );

  const body = (await (await GET({} as never, params)).json()) as {
    run: Record<string, unknown>;
  };
  expect(body.run.passedCount).toBe(1);
  expect(body.run.failedCount).toBe(1);
  expect(body.run.erroredCount).toBe(1);
  expect(body.run.notScoredCount).toBe(0);
});
