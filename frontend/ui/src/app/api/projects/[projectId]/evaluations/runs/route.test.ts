/**
 * Run-list derivation. Status counts, pass rate, cost and duration come from one
 * grouped aggregate — no result rows cross the wire for them. The restrained
 * comparison summary (regressedCaseCount + trustworthy scalar delta) still comes from
 * the SAME engine as run detail, but only for runs that declare a baseline, batched so
 * a page is a bounded number of queries and never a per-row N+1.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationRun: { findMany: vi.fn(), count: vi.fn() },
  dataset: { findMany: vi.fn() },
  evaluationResult: { findMany: vi.fn(), groupBy: vi.fn() },
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

/**
 * One row as `groupBy(["runId", "status"])` returns it. Counts, cost and case
 * duration are aggregated in the database, so the route never sees result rows for
 * them — only these groups.
 */
function group(
  runId: string,
  status: string,
  count: number,
  sums: { cost?: number; durationMs?: number } = {},
) {
  return {
    runId,
    status,
    _count: { _all: count },
    _sum: { cost: sums.cost ?? null, durationMs: sums.durationMs ?? null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.$transaction.mockImplementation(async (arr: Promise<unknown>[]) => Promise.all(arr));
  prismaMock.dataset.findMany.mockResolvedValue([{ id: "ds1", name: "support" }]);
  prismaMock.evaluationResult.groupBy.mockResolvedValue([]);
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
  // Bounded: one page-runs query + one baselines query + one grouped aggregate + one
  // comparison-results query (+ datasets).
  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledTimes(2);
  expect(prismaMock.evaluationResult.groupBy).toHaveBeenCalledTimes(1);
  expect(prismaMock.evaluationResult.findMany).toHaveBeenCalledTimes(1);
  // The comparison rows are projected, not slurped: the unbounded TEXT columns the
  // engine never reads (input, expectedOutput, baselineOutput, taskError) stay in the
  // database. `include: { scores: true }` would have pulled all of them.
  const resultArgs = prismaMock.evaluationResult.findMany.mock.calls[0][0];
  expect(resultArgs.include).toBeUndefined();
  expect(Object.keys(resultArgs.select).sort()).toEqual([
    "candidateOutput",
    "durationMs",
    "mainScore",
    "runId",
    "scores",
    "status",
    "testCaseId",
  ]);
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
  // Mid-flight with no cases yet: nothing to derive a duration from either way.
  expect(row.elapsedMs).toBeNull();
  // No baseline ids → the baselines findMany is skipped (only the page-runs query ran),
  // and with no run on the page declaring a baseline the per-case comparison query is
  // skipped entirely. The status counts still come back — from the grouped aggregate.
  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledTimes(1);
  expect(prismaMock.evaluationResult.findMany).not.toHaveBeenCalled();
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
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    group("run_c", "passed", 2),
    group("run_c", "failed", 1),
    group("run_c", "errored", 1),
    group("run_c", "not_scored", 1),
  ]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  expect(body.data[0].passedCount).toBe(2);
  expect(body.data[0].failedCount).toBe(1);
  expect(body.data[0].erroredCount).toBe(1);
  expect(body.data[0].notScoredCount).toBe(1);
});

it("returns the pass rate, derived from the same counts", async () => {
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([
    {
      id: "run_c",
      projectId: "p1",
      evaluationId: "e1",
      datasetId: "ds1",
      datasetVersionId: "dv1",
      runNumber: 2,
      candidateVersion: "sonnet",
      status: "completed",
      baselineRunId: null,
      mainScore: 0.66,
      mainScoreName: "acc",
      taskErrorCount: 0,
      scorerErrorCount: 0,
      scorers: [],
      startedAt: new Date("2026-07-21T00:00:00Z"),
      completedAt: new Date("2026-07-21T00:00:05Z"),
      evaluation: { name: "ticket-routing" },
      datasetVersion: { label: "v1" },
    },
  ]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    group("run_c", "passed", 18),
    group("run_c", "failed", 4),
    group("run_c", "errored", 2),
    group("run_c", "not_scored", 1),
  ]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  // Exact, not toBeCloseTo: a loose tolerance would also accept a denominator that
  // wrongly folded in the errored and not-scored cases.
  expect(body.data[0].passRate).toBe(18 / 22);
  expect(body.data[0].excludedSummary).toBe("2 errored, 1 not scored");
});

// The load-bearing rule, on the wire rather than left to each client: a run whose
// harness broke must render "—", not a catastrophic-looking 0%.
it("returns a null pass rate for an all-errored run, never 0", async () => {
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([
    {
      id: "run_c",
      projectId: "p1",
      evaluationId: "e1",
      datasetId: "ds1",
      datasetVersionId: "dv1",
      runNumber: 3,
      candidateVersion: "sonnet",
      status: "completed_with_errors",
      baselineRunId: null,
      mainScore: null,
      mainScoreName: "acc",
      taskErrorCount: 3,
      scorerErrorCount: 0,
      scorers: [],
      startedAt: new Date("2026-07-21T00:00:00Z"),
      completedAt: new Date("2026-07-21T00:00:05Z"),
      evaluation: { name: "ticket-routing" },
      datasetVersion: { label: "v1" },
    },
  ]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.groupBy.mockResolvedValue([group("run_c", "errored", 3)]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  expect(body.data[0].passRate).toBeNull();
  expect(body.data[0].passRate).not.toBe(0);
  expect(body.data[0].excludedSummary).toBe("3 errored");
});

// A non-terminal run still reports a running duration. Returning null
// would blank the duration column on exactly the row someone is watching.
it("reports a running duration for a mid-flight run with no completedAt", async () => {
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([
    {
      id: "run_live",
      projectId: "p1",
      evaluationId: "e1",
      datasetId: "ds1",
      datasetVersionId: "dv1",
      runNumber: 4,
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
    },
  ]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    group("run_live", "passed", 80, { cost: 0.4, durationMs: 72000 }),
    group("run_live", "failed", 40, { cost: 0.2, durationMs: 36000 }),
  ]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  const row = body.data[0];
  expect(row.elapsedMs).toBe(108000);
  // Partial counts and cost stay coherent beside it.
  expect(row.passedCount).toBe(80);
  expect(row.failedCount).toBe(40);
  expect(row.passRate).toBe(80 / 120);
  expect(row.cost).toBeCloseTo(0.6);
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

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  expect(body.data[0].passedCount).toBe(0);
  expect(body.data[0].failedCount).toBe(0);
  expect(body.data[0].passRate).toBeNull();
  // Still exactly one grouped query — the counts add no round trips.
  expect(prismaMock.evaluationResult.groupBy).toHaveBeenCalledTimes(1);
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
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    group("run_c", "passed", 1),
    group("run_c", "failed", 1),
  ]);

  const body = (await (await GET(nextUrl() as never, params)).json()) as {
    data: Record<string, unknown>[];
  };
  expect(body.data[0].passedCount).toBe(1);
  expect(body.data[0].failedCount).toBe(1);
  // The served rate uses the derived denominator, not scoredCount — 1/2, not 1/9.
  expect(body.data[0].passRate).toBe(0.5);
  // The stored counter is passed through untouched — it is not reconciled in v1.
  expect(body.data[0].scoredCount).toBe(9);
});

// ── sort/order whitelist + started_after/started_before ────────────────────

function run(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run_x",
    projectId: "p1",
    evaluationId: "e1",
    datasetId: "ds1",
    datasetVersionId: "dv1",
    runNumber: 1,
    candidateVersion: "sonnet",
    status: "completed",
    baselineRunId: null,
    mainScore: 0.5,
    mainScoreName: "acc",
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [],
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: new Date("2026-07-21T00:00:05Z"),
    evaluation: { name: "ticket-routing" },
    datasetVersion: { label: "v1" },
    ...overrides,
  };
}

it("whitelists sort — an unrecognized value falls back to startedAt desc, never reaching orderBy raw", async () => {
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([run()]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);

  await GET(nextUrl("sort=%27%3B%20DROP%20TABLE%20runs%3B--&order=asc") as never, params);

  // sort is unrecognized, so it falls back to the default field (startedAt);
  // order is independently valid ("asc") and still applies to that field —
  // the point is that the raw sort value never reaches `orderBy`.
  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ orderBy: { startedAt: "asc" } }),
  );
});

it("sorts by mainScore ascending via the DB when sort=mainScore&order=asc", async () => {
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([run()]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);

  await GET(nextUrl("sort=mainScore&order=asc") as never, params);

  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ orderBy: { mainScore: "asc" } }),
  );
});

it("sorts by cost across the FULL filtered set (not just the fetched page), nulls last", async () => {
  const cheap = run({ id: "run_cheap" });
  const pricey = run({ id: "run_pricey" });
  const noCost = run({ id: "run_no_cost" });
  // No skip/take here — the cost/elapsedMs branch fetches the whole filtered
  // set once (not paginated) so it can sort before slicing to a page.
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([cheap, pricey, noCost]);
  // The route asks for `_count: { _all: true }` alongside `_sum`, and reads
  // `g._count._all` to derive the per-status counts — so the group rows must
  // carry it or the handler throws before the sort is ever exercised.
  prismaMock.evaluationResult.groupBy.mockResolvedValue([
    { runId: "run_cheap", status: "passed", _count: { _all: 1 }, _sum: { cost: 1.5 } },
    { runId: "run_pricey", status: "passed", _count: { _all: 1 }, _sum: { cost: 42 } },
    // run_no_cost has no group row at all (no results with a non-null cost).
  ]);
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);

  const body = (await (await GET(nextUrl("sort=cost&order=desc") as never, params)).json()) as {
    data: Record<string, unknown>[];
    meta: { total: number };
  };

  expect(body.data.map((r) => r.id)).toEqual(["run_pricey", "run_cheap", "run_no_cost"]);
  expect(body.meta.total).toBe(3);
  // This branch never asks the DB to order/paginate directly — it derives the
  // sort key itself and slices after.
  expect(prismaMock.evaluationRun.count).not.toHaveBeenCalled();
});

it("sorts by elapsedMs, treating a still-running run (no completedAt) as sorting last", async () => {
  const slow = run({
    id: "run_slow",
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: new Date("2026-07-21T00:10:00Z"),
  });
  const fast = run({
    id: "run_fast",
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: new Date("2026-07-21T00:00:01Z"),
  });
  const running = run({
    id: "run_running",
    startedAt: new Date("2026-07-21T00:00:00Z"),
    completedAt: null,
  });
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([slow, fast, running]);
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);

  const body = (await (await GET(nextUrl("sort=elapsedMs&order=asc") as never, params)).json()) as {
    data: Record<string, unknown>[];
  };

  expect(body.data.map((r) => r.id)).toEqual(["run_fast", "run_slow", "run_running"]);
});

it("narrows to a startedAt window via started_after/started_before", async () => {
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([run()]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);

  await GET(
    nextUrl(
      "started_after=2026-07-01T00:00:00.000Z&started_before=2026-07-31T00:00:00.000Z",
    ) as never,
    params,
  );

  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        startedAt: {
          gte: new Date("2026-07-01T00:00:00.000Z"),
          lte: new Date("2026-07-31T00:00:00.000Z"),
        },
      }),
    }),
  );
});

it("drops an unparseable started_after instead of erroring", async () => {
  prismaMock.evaluationRun.findMany.mockResolvedValueOnce([run()]);
  prismaMock.evaluationRun.count.mockResolvedValue(1);
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);

  await GET(nextUrl("started_after=not-a-date") as never, params);

  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.not.objectContaining({ startedAt: expect.anything() }),
    }),
  );
});
