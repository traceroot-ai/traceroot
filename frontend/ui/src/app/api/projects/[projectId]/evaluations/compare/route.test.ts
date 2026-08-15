/**
 * Cross-run comparison (`?candidate=&baseline=`). The route assembles already-fetched
 * rows and delegates all comparison MATH to the pure engine. Its own job is the
 * assembly contract: canonical case content comes from the CANDIDATE's pinned dataset
 * version (with a divergence flag when a run recorded something else), baseline-only
 * cases are appended rather than silently dropped, and both run ids must be present,
 * different, and readable in this project. Auth + Prisma are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationRun: { findFirst: vi.fn() },
  testCase: { findMany: vi.fn() },
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
const req = (qs: string) =>
  ({ nextUrl: { searchParams: new URLSearchParams(qs) } }) as unknown as Parameters<typeof GET>[0];
const BOTH = "candidate=run_c&baseline=run_b";

interface Body {
  candidate: Record<string, unknown>;
  baseline: Record<string, unknown>;
  comparison: Record<string, unknown>;
  results: Record<string, unknown>[];
}

function score(name: string, numericValue: number | null) {
  return {
    scorerName: name,
    scorerVersion: "unversioned",
    numericValue,
    boolValue: null,
    stringValue: null,
    passed: numericValue === 1,
    explanation: `because ${numericValue}`,
    error: null,
  };
}

function resultRow(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    testCaseId: "t0",
    traceId: "tr_c0",
    input: "a ticket",
    expectedOutput: "billing",
    candidateOutput: "billing",
    status: "passed",
    mainScore: 1,
    taskError: null,
    durationMs: 900,
    cost: 0.01,
    scores: [score("acc", 1)],
    ...over,
  };
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run_c",
    projectId: "p1",
    evaluationId: "eval_1",
    datasetId: "ds1",
    datasetVersionId: "dv2",
    runNumber: 2,
    candidateVersion: "sonnet",
    status: "completed",
    baselineRunId: null,
    mainScore: 0.5,
    mainScoreName: "acc",
    caseCount: 2,
    scoredCount: 2,
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [{ name: "acc", version: "unversioned", value_type: "numeric" }],
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: new Date("2026-07-21T00:00:06Z"),
    evaluation: { name: "ticket-routing" },
    datasetVersion: { label: "v2" },
    results: [
      resultRow(),
      resultRow({
        id: "r2",
        testCaseId: "t5",
        traceId: "tr_c5",
        input: "another ticket",
        expectedOutput: "technical",
        candidateOutput: "general",
        mainScore: 0,
        durationMs: 1000,
        scores: [score("acc", 0)],
      }),
    ],
    ...over,
  };
}

function baselineRun(over: Record<string, unknown> = {}) {
  return run({
    id: "run_b",
    runNumber: 1,
    candidateVersion: "opus",
    mainScore: 1,
    startedAt: new Date("2026-07-20T00:00:00Z"),
    completedAt: new Date("2026-07-20T00:00:04Z"),
    results: [
      resultRow({ id: "b1", traceId: "tr_b0", cost: 0.02, durationMs: 800 }),
      resultRow({
        id: "b2",
        testCaseId: "t5",
        traceId: "tr_b5",
        input: "another ticket",
        expectedOutput: "technical",
        candidateOutput: "technical",
        mainScore: 1,
        durationMs: 850,
        scores: [score("acc", 1)],
      }),
    ],
    ...over,
  });
}

const canonicalRow = (over: Record<string, unknown> = {}) => ({
  testCaseId: "t0",
  input: "a ticket",
  expected: "billing",
  metadata: { locale: "en" },
  sourceTraceId: "tr_origin",
  sourceSpanName: "handle_ticket",
  sourceSpanKind: "SERVER",
  captureReason: "manual",
  ...over,
});

async function body(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Body;
}

/** Wire both loads: the route fires candidate + baseline in one Promise.all. */
function loadRuns(candidate: unknown, baseline: unknown) {
  prismaMock.evaluationRun.findFirst.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === "run_c" ? candidate : args.where.id === "run_b" ? baseline : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.testCase.findMany.mockResolvedValue([
    canonicalRow(),
    canonicalRow({
      testCaseId: "t5",
      input: "another ticket",
      expected: "technical",
      metadata: null,
      sourceTraceId: null,
    }),
  ]);
});

describe("assembly", () => {
  it("pairs both sides per case with outputs, traces, costs, scores, and a verdict", async () => {
    loadRuns(run(), baselineRun());

    const res = await GET(req(BOTH), params);
    expect(res.status).toBe(200);
    const b = await body(res);

    expect(b.candidate).toMatchObject({ id: "run_c", runNumber: 2, elapsedMs: 6000 });
    expect(b.baseline).toMatchObject({ id: "run_b", runNumber: 1, elapsedMs: 4000 });
    expect(b.comparison.available).toBe(true);

    const t5 = b.results.find((r) => r.testCaseId === "t5")!;
    expect(t5.candidateOutput).toBe("general");
    expect(t5.baselineOutput).toBe("technical");
    expect(t5.candidateTraceId).toBe("tr_c5");
    expect(t5.baselineTraceId).toBe("tr_b5");
    expect(t5.outputChanged).toBe(true);
    expect(t5.change).toBe("regressed");
    // Raw per-scorer values, including the judge's explanation, for the case drawer.
    expect(t5.candidateScores).toEqual([
      {
        scorerName: "acc",
        scorerVersion: "unversioned",
        numericValue: 0,
        boolValue: null,
        stringValue: null,
        passed: false,
        explanation: "because 0",
        error: null,
      },
    ]);
    expect((t5.comparison as { regressedCellCount: number }).regressedCellCount).toBe(1);

    const t0 = b.results.find((r) => r.testCaseId === "t0")!;
    expect(t0.outputChanged).toBe(false);
    expect(t0.candidateCost).toBe(0.01);
    expect(t0.baselineCost).toBe(0.02);
  });

  it("takes input/expected/metadata/provenance from the candidate's pinned version", async () => {
    loadRuns(
      run({ results: [resultRow({ input: "STALE COPY", expectedOutput: "STALE" })] }),
      baselineRun(),
    );

    const t0 = (await body(await GET(req(BOTH), params))).results[0];
    expect(t0.input).toBe("a ticket"); // canonical, not the run's stale copy
    expect(t0.expectedOutput).toBe("billing");
    expect(t0.metadata).toEqual({ locale: "en" });
    expect(t0.provenance).toMatchObject({ sourceTraceId: "tr_origin", captureReason: "manual" });
    // ...and the divergence is flagged rather than hidden.
    expect(t0.inputMatchesDataset).toBe(false);

    // One canonical query for the whole comparison, scoped to the pinned version.
    expect(prismaMock.testCase.findMany).toHaveBeenCalledTimes(1);
    const where = prismaMock.testCase.findMany.mock.calls[0][0].where as {
      datasetVersionId: string;
      projectId: string;
      testCaseId: { in: string[] };
    };
    expect(where.datasetVersionId).toBe("dv2");
    expect(where.projectId).toBe("p1");
    // Narrowed to the cases the two runs actually reference, so a comparison of a
    // handful of cases doesn't read the whole pinned version.
    expect(where.testCaseId.in).toEqual(["t0", "t5"]);
  });

  it("reports no provenance for a case that was not captured from a trace", async () => {
    loadRuns(run(), baselineRun());
    const t5 = (await body(await GET(req(BOTH), params))).results.find(
      (r) => r.testCaseId === "t5",
    )!;
    expect(t5.provenance).toBeNull();
    expect(t5.metadata).toBeNull();
  });

  it("falls back to a run's recorded content when the case is not in the pinned version", async () => {
    prismaMock.testCase.findMany.mockResolvedValue([]); // nothing canonical
    loadRuns(run(), baselineRun());

    const t0 = (await body(await GET(req(BOTH), params))).results[0];
    expect(t0.input).toBe("a ticket"); // from the candidate result row
    expect(t0.expectedOutput).toBe("billing");
    expect(t0.metadata).toBeNull();
    // With no canonical case to diverge from, nothing is flagged.
    expect(t0.inputMatchesDataset).toBe(true);
  });

  it("appends baseline-only cases instead of dropping them", async () => {
    const droppedCase = resultRow({
      id: "b3",
      testCaseId: "t9",
      traceId: "tr_b9",
      input: "dropped ticket",
      candidateOutput: "billing",
    });
    loadRuns(run(), baselineRun({ results: [...baselineRun().results, droppedCase] }));

    const b = await body(await GET(req(BOTH), params));
    const dropped = b.results.find((r) => r.testCaseId === "t9")!;
    // Candidate-side cases keep their reported order; the dropped case comes last.
    expect(b.results.map((r) => r.testCaseId)).toEqual(["t0", "t5", "t9"]);
    expect(dropped.candidateStatus).toBeNull();
    expect(dropped.candidateOutput).toBeNull();
    expect(dropped.baselineOutput).toBe("billing");
    expect(dropped.input).toBe("dropped ticket");
    expect(dropped.outputChanged).toBe(true); // exactly one side has an output
  });

  it("reports outputChanged as null when neither side produced an output", async () => {
    loadRuns(
      run({
        results: [resultRow({ candidateOutput: null, status: "errored", taskError: "boom" })],
      }),
      baselineRun({ results: [resultRow({ id: "b1", candidateOutput: null })] }),
    );

    const t0 = (await body(await GET(req(BOTH), params))).results[0];
    expect(t0.outputChanged).toBeNull();
    expect(t0.candidateTaskError).toBe("boom");
    expect(t0.candidateStatus).toBe("errored");
  });

  it("reports a null elapsed time for a run that has not completed", async () => {
    loadRuns(run({ status: "running", completedAt: null }), baselineRun());
    const b = await body(await GET(req(BOTH), params));
    expect(b.candidate.elapsedMs).toBeNull();
    expect(b.baseline.elapsedMs).toBe(4000);
  });

  it("refuses to trust the comparison when the two runs pinned different snapshots", async () => {
    loadRuns(run(), baselineRun({ datasetVersionId: "dv1" }));
    const b = await body(await GET(req(BOTH), params));
    expect(b.comparison.trustworthy).toBe(false);
    expect(b.comparison.reasons).toContain("different_dataset_version");
  });
});

describe("request validation", () => {
  it("400s when the candidate id is missing", async () => {
    const res = await GET(req("baseline=run_b"), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Both candidate and baseline run ids are required",
    });
    expect(prismaMock.evaluationRun.findFirst).not.toHaveBeenCalled();
  });

  it("400s when the baseline id is missing", async () => {
    expect((await GET(req("candidate=run_c"), params)).status).toBe(400);
  });

  it("400s when both ids are the same run", async () => {
    const res = await GET(req("candidate=run_c&baseline=run_c"), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Pick two different runs to compare" });
  });

  it("404s an unreadable candidate run", async () => {
    loadRuns(null, baselineRun());
    const res = await GET(req(BOTH), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Candidate run not found" });
  });

  it("404s an unreadable baseline run", async () => {
    loadRuns(run(), null);
    const res = await GET(req(BOTH), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Baseline run not found" });
  });

  it("scopes both run loads to the project", async () => {
    loadRuns(run(), baselineRun());
    await GET(req(BOTH), params);
    const wheres = prismaMock.evaluationRun.findFirst.mock.calls.map((c) => c[0].where);
    expect(wheres).toEqual([
      { id: "run_c", projectId: "p1" },
      { id: "run_b", projectId: "p1" },
    ]);
  });

  it("401s an unauthenticated caller before touching the database", async () => {
    auth.requireAuth.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    expect((await GET(req(BOTH), params)).status).toBe(401);
    expect(prismaMock.evaluationRun.findFirst).not.toHaveBeenCalled();
  });

  it("403s a caller without project access", async () => {
    auth.requireProjectAccess.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    expect((await GET(req(BOTH), params)).status).toBe(403);
    expect(prismaMock.evaluationRun.findFirst).not.toHaveBeenCalled();
  });
});
