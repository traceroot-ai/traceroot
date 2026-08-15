/**
 * Run/result read-back validation (Phase H).
 *
 * A reported run, read back through the run-detail route, must expose: the exact
 * dataset version, candidate version, run identity, each result's trace id, scores
 * with INDEPENDENT scorer errors, the task error, the run status/finality, human
 * scores, and the baseline relationship. prisma is mocked with a fully-formed run
 * (the route uses nested `include`), so this asserts the route's exposure + derived
 * fields, not the storage engine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted(() => ({ requireAuth: vi.fn(), requireProjectAccess: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: auth.requireAuth,
  requireProjectAccess: auth.requireProjectAccess,
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));

const db = vi.hoisted(() => ({
  run: null as unknown,
  baseline: null as unknown,
  dataset: null as unknown,
}));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    prisma: {
      // The route fetches the candidate (id run1) and then the baseline (id run0).
      evaluationRun: {
        findFirst: vi.fn(async (args: { where: { id: string } }) =>
          args.where.id === "run0" ? db.baseline : args.where.id === "run1" ? db.run : null,
        ),
      },
      // Status counts come from a grouped aggregate over the whole run; derive it from the
      // fixture's own results so the counts stay consistent with what the run declares.
      evaluationResult: {
        groupBy: vi.fn(async (args: { where: { runId: string } }) => {
          const src =
            args.where.runId === "run0" ? db.baseline : args.where.runId === "run1" ? db.run : null;
          const results = (src as { results?: Array<{ status: string }> } | null)?.results ?? [];
          const counts = new Map<string, number>();
          for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
          return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
        }),
        // Run duration = the sum of every case's duration (over all results).
        aggregate: vi.fn(async (args: { where: { runId: string } }) => {
          const src =
            args.where.runId === "run0" ? db.baseline : args.where.runId === "run1" ? db.run : null;
          const results =
            (src as { results?: Array<{ durationMs?: number | null }> } | null)?.results ?? [];
          const present = results.map((r) => r.durationMs).filter((d): d is number => d != null);
          return {
            _sum: { durationMs: present.length > 0 ? present.reduce((a, b) => a + b, 0) : null },
          };
        }),
      },
      dataset: { findFirst: vi.fn(async () => db.dataset) },
    },
  };
});

import { GET } from "./route";

const PROJECT_ID = "p1";
const params = (runId: string) => ({
  params: Promise.resolve({ projectId: PROJECT_ID, runId }),
});

beforeEach(() => {
  auth.requireAuth.mockResolvedValue({ user: { id: "u1", email: "e@x.com" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: PROJECT_ID } });
  db.dataset = { id: "ds1", name: "Billing routing" };
  db.run = {
    id: "run1",
    projectId: PROJECT_ID,
    evaluationId: "eval1",
    datasetId: "ds1",
    datasetVersionId: "dv12",
    runNumber: 27,
    candidateVersion: "git:4a91c02",
    status: "completed_with_errors",
    mainScore: 0.9,
    mainScoreName: "routing-accuracy",
    caseCount: 3,
    scoredCount: 2,
    taskErrorCount: 1,
    scorerErrorCount: 1,
    baselineRunId: "run0",
    scorers: [{ name: "routing-accuracy", version: "v3" }],
    evaluation: { name: "Billing routing" },
    datasetVersion: { label: "v12" },
    baselineRun: {
      id: "run0",
      runNumber: 26,
      candidateVersion: "git:0000000",
      mainScore: 0.75,
      evaluationId: "eval1",
      datasetVersionId: "dv12", // same version → comparable
      datasetVersion: { label: "v12" },
    },
    results: [
      {
        id: "res1",
        runId: "run1",
        testCaseId: "case-1",
        traceId: "tr_abc",
        status: "passed",
        mainScore: 1,
        taskError: null,
        candidateOutput: "billing",
        scores: [
          {
            id: "s1",
            scorerName: "routing-accuracy",
            scorerVersion: "v3",
            numericValue: 1,
            error: null,
          },
          // Independent scorer error: value null, error set — never a zero.
          {
            id: "s2",
            scorerName: "helpfulness",
            scorerVersion: "v2",
            numericValue: null,
            error: "Judge returned malformed JSON",
          },
        ],
        humanScores: [
          {
            id: "h1",
            dimension: "overall",
            verdict: "pass",
            quality: 4,
            comment: "looks right",
            reviewer: "e@x.com",
            status: "reviewed",
          },
        ],
      },
      {
        id: "res2",
        runId: "run1",
        testCaseId: "case-2",
        traceId: null,
        status: "errored",
        mainScore: null,
        // Task error: the application failed, distinct from a scorer error.
        taskError: "ToolTimeout: lookup_invoice timed out",
        candidateOutput: null,
        scores: [],
        humanScores: [],
      },
    ],
  };
  // The baseline run (fetched separately by the route) with raw results/scores that
  // pair on the main scorer so the derived comparison is trustworthy.
  db.baseline = {
    id: "run0",
    projectId: PROJECT_ID,
    evaluationId: "eval1",
    datasetId: "ds1",
    datasetVersionId: "dv12",
    runNumber: 26,
    candidateVersion: "git:0000000",
    status: "completed",
    baselineRunId: null,
    mainScore: 0.75,
    mainScoreName: "routing-accuracy",
    scorers: [{ name: "routing-accuracy", version: "v3" }],
    results: [
      {
        testCaseId: "case-1",
        status: "passed",
        mainScore: 0.5,
        candidateOutput: "billing",
        durationMs: 700,
        scores: [
          { scorerName: "routing-accuracy", scorerVersion: "v3", numericValue: 0.5, error: null },
        ],
      },
      {
        testCaseId: "case-2",
        status: "passed",
        mainScore: 1,
        candidateOutput: "technical",
        durationMs: 720,
        scores: [
          { scorerName: "routing-accuracy", scorerVersion: "v3", numericValue: 1, error: null },
        ],
      },
    ],
  };
});

async function read(runId = "run1") {
  const res = await GET({} as never, params(runId));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("run/result read-back", () => {
  it("exposes run identity, exact dataset version, candidate, and status/finality", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    const run = body.run as Record<string, unknown>;
    expect(run.id).toBe("run1");
    expect(run.runNumber).toBe(27);
    expect(run.datasetVersionId).toBe("dv12");
    expect(run.datasetVersionLabel).toBe("v12");
    expect(run.candidateVersion).toBe("git:4a91c02");
    expect(run.status).toBe("completed_with_errors");
    expect(run.errorCount).toBe(2); // taskErrorCount + scorerErrorCount
  });

  it("exposes the baseline relationship and comparable delta", async () => {
    const run = (await read()).body.run as Record<string, unknown>;
    expect(run.baselineRunId).toBe("run0");
    expect(run.baselineComparable).toBe(true);
    // NOT the raw run.mainScore subtraction (0.9 - 0.75 = 0.15): case-2's candidate
    // task errored (no routing-accuracy score), so it's excluded from the paired
    // aggregate. The only actually-comparable case is case-1 (candidate 1 vs
    // baseline 0.5), so the trustworthy headline delta is 0.5, derived the same way
    // as every per-scorer aggregate — never a subtraction of the two runs' raw
    // SDK-reported aggregates, which can silently cover different case sets.
    expect(run.changeFromBaseline).toBeCloseTo(0.5);
  });

  it("exposes result trace id, task error, scores with independent scorer errors, and human scores", async () => {
    const results = (await read()).body.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);

    const passed = results.find((r) => r.testCaseId === "case-1")!;
    expect(passed.traceId).toBe("tr_abc");
    const scores = passed.scores as Array<Record<string, unknown>>;
    const helpfulness = scores.find((s) => s.scorerName === "helpfulness")!;
    expect(helpfulness.error).toContain("malformed JSON");
    expect(helpfulness.numericValue).toBeNull(); // scorer error is not a zero
    expect((passed.humanScores as unknown[]).length).toBe(1);

    const errored = results.find((r) => r.testCaseId === "case-2")!;
    expect(errored.status).toBe("errored");
    expect(errored.taskError).toContain("ToolTimeout");
    expect(errored.candidateOutput).toBeNull();
    expect((errored.scores as unknown[]).length).toBe(0);
  });

  it("does not surface an SDK-identity provenance block on the read model", async () => {
    const run = (await read()).body.run as Record<string, unknown>;
    // Evaluation identity is SDK-agnostic: a run carries no git/CI/SDK provenance.
    expect("provenance" in run).toBe(false);
    // The dropped orphan `model` column no longer appears on the read model.
    expect("model" in run).toBe(false);
  });

  it("derives the human-review summary read-only, without touching automated signals", async () => {
    // res1 (auto passed) carries an "overall" human pass; res2 (auto errored) has none.
    const run = (await read()).body.run as Record<string, unknown>;
    const hr = run.humanReview as Record<string, number | string[]>;
    expect(hr.dimensions).toEqual(["overall"]);
    expect(hr.reviewedCount).toBe(1);
    expect(hr.pendingCount).toBe(1); // res2 not reviewed on the active "overall" dimension
    expect(hr.passCount).toBe(1);
    expect(hr.failCount).toBe(0);
    expect(hr.disagreementCount).toBe(0); // human pass agrees with the automated pass
    // Automated signals are exactly what the comparison/status produce — never rewritten.
    expect(run.status).toBe("completed_with_errors");
    expect(run.changeFromBaseline).toBeCloseTo(0.5);
    expect(run.baselineComparable).toBe(true);
  });

  it("counts a human-vs-automated disagreement without changing the automated verdict", async () => {
    // Flip the human verdict on the auto-passed result to a fail → one disagreement.
    (
      db.run as { results: Array<{ humanScores: Array<{ verdict: string }> }> }
    ).results[0].humanScores[0].verdict = "fail";
    const run = (await read()).body.run as Record<string, unknown>;
    const hr = run.humanReview as Record<string, number>;
    expect(hr.disagreementCount).toBe(1);
    expect(hr.failCount).toBe(1);
    // The automated main score / status / comparison are untouched by the disagreement.
    expect(run.mainScore).toBe(0.9);
    expect(run.status).toBe("completed_with_errors");
    expect(run.changeFromBaseline).toBeCloseTo(0.5);
  });

  it("marks an incompatible baseline (different dataset version) as not comparable", async () => {
    (db.baseline as { datasetVersionId: string }).datasetVersionId = "dv11";
    const run = (await read()).body.run as Record<string, unknown>;
    expect(run.baselineComparable).toBe(false);
    expect(run.changeFromBaseline).toBeNull();
    const cmp = run.comparison as { reasons: string[]; state: string };
    expect(cmp.reasons).toContain("different_dataset_version");
    // Computed but non-authoritative → the explicit `exploratory` state, distinct on
    // the wire from a still-running `pending` comparison.
    expect(cmp.state).toBe("exploratory");
  });

  it("404s an unknown run", async () => {
    db.run = null;
    expect((await read("missing")).status).toBe(404);
  });
});
