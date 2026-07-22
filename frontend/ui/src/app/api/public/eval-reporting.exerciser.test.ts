/**
 * Local SDK contract exerciser.
 *
 * Drives the real public reporting Route Handlers end to end against an in-memory
 * fake prisma — the smallest thing that simulates what the SDK will eventually
 * do: fetch a pinned snapshot, register a run, report successful and failed
 * results (task error vs scorer error vs not-scored), link a trace, and complete
 * the run. No database, no network. Proves the reporting contract + idempotency +
 * out-of-order trace arrival hold.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
  NextRequest: class {},
}));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  const { fakePrisma } = await import("@/lib/eval/__tests__/fake-prisma");
  return { ...actual, prisma: fakePrisma };
});

import { fakePrisma } from "@/lib/eval/__tests__/fake-prisma";
import { hashApiKey } from "@/lib/api-keys";
import { POST as registerRun } from "./evaluation-runs/route";
import { POST as upsertResult } from "./evaluation-runs/[runId]/results/route";
import { POST as completeRun } from "./evaluation-runs/[runId]/complete/route";

const API_KEY = "tr-test-key";
const PROJECT_ID = "proj_1";

function req(body: unknown) {
  return {
    headers: new Headers({ authorization: `Bearer ${API_KEY}` }),
    json: async () => body,
  } as unknown as Request;
}
const params = (runId: string) => ({ params: Promise.resolve({ runId }) });

async function readJson(res: { json: () => Promise<unknown> }) {
  return res.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  fakePrisma.reset();
  // An API key resolving to PROJECT_ID (the SDK's Bearer credential).
  fakePrisma.accessKey.rows.push({
    secretHash: hashApiKey(API_KEY),
    projectId: PROJECT_ID,
    expireTime: null,
    project: { deleteTime: null },
  });
  // A dataset pinned to version dv1 with two test cases.
  fakePrisma.dataset.rows.push({
    id: "ds1",
    projectId: PROJECT_ID,
    currentVersionId: "dv1",
  });
  fakePrisma.datasetVersion.rows.push({ id: "dv1", datasetId: "ds1", projectId: PROJECT_ID });
  fakePrisma.testCase.rows.push(
    { id: "tcrow1", testCaseId: "case-1", datasetVersionId: "dv1", projectId: PROJECT_ID },
    { id: "tcrow2", testCaseId: "case-2", datasetVersionId: "dv1", projectId: PROJECT_ID },
  );
});

describe("SDK reporting: authentication", () => {
  it("rejects a missing/invalid API key", async () => {
    const noKey = { headers: new Headers(), json: async () => ({}) } as unknown as Request;
    const res = await registerRun(noKey);
    expect(res.status).toBe(401);
  });
});

describe("SDK reporting: full run lifecycle", () => {
  it("registers, reports every result state, links a trace, and completes", async () => {
    // 1. Register — evaluation lineage is created, server assigns run_number 1.
    const reg = await registerRun(
      req({
        evaluation_name: "Billing routing",
        dataset_id: "ds1",
        candidate_version: "git:abc123",
        main_score_name: "Routing accuracy",
        scorers: [
          { name: "routing-accuracy", version: "v3" },
          { name: "helpfulness", version: "v2" },
        ],
        client_run_id: "client-1",
      }),
    );
    expect(reg.status).toBe(201);
    const regBody = await readJson(reg);
    const runId = regBody.evaluation_run_id as string;
    expect(regBody.run_number).toBe(1);
    expect(regBody.dataset_version_id).toBe("dv1");
    // UI-relative run path (back-compat).
    expect(regBody.run_path).toBe(`/projects/${PROJECT_ID}/evaluations/${runId}`);
    // Absolute clickable URL the SDK prints — run_path resolved against the app origin.
    const appBase = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    expect(regBody.run_url).toBe(
      new URL(`/projects/${PROJECT_ID}/evaluations/${runId}`, appBase).toString(),
    );
    expect(fakePrisma.evaluation.rows).toHaveLength(1);

    // Idempotency: same client_run_id returns the same run, no duplicate.
    const reg2 = await registerRun(
      req({
        evaluation_name: "Billing routing",
        dataset_id: "ds1",
        candidate_version: "git:abc123",
        client_run_id: "client-1",
      }),
    );
    expect((await readJson(reg2)).evaluation_run_id).toBe(runId);
    expect(fakePrisma.evaluationRun.rows).toHaveLength(1);

    // 2a. A clean passing result, linked to a trace, with scores.
    await upsertResult(
      req({
        test_case_id: "case-1",
        trace_id: "trace-aaa",
        input: "double charge refund?",
        candidate_output: "billing",
        expected_output: "billing",
        status: "passed",
        main_score: 1,
        change: "improved",
        scores: [
          { scorer_name: "routing-accuracy", scorer_version: "v3", numeric_value: 1 },
          { scorer_name: "helpfulness", scorer_version: "v2", numeric_value: 0.9 },
        ],
      }),
      params(runId),
    );

    // 2b. A task/application error — no output, no scores.
    await upsertResult(
      req({
        test_case_id: "case-2",
        input: "invoice never arrived",
        candidate_output: null,
        status: "errored",
        task_error: "ToolTimeout: lookup_invoice timed out",
        scores: [],
      }),
      params(runId),
    );

    // 2c. A scorer error on an otherwise-passing result (kept, not a zero).
    await upsertResult(
      req({
        test_case_id: "case-3",
        trace_id: "trace-ccc",
        input: "explain the tax line",
        candidate_output: "billing",
        status: "passed",
        main_score: 1,
        scores: [
          { scorer_name: "routing-accuracy", scorer_version: "v3", numeric_value: 1 },
          {
            scorer_name: "helpfulness",
            scorer_version: "v2",
            numeric_value: null,
            error: "Judge returned malformed JSON",
          },
        ],
      }),
      params(runId),
    );

    // 2d. A not-scored result — every scorer failed, no main score.
    await upsertResult(
      req({
        test_case_id: "case-4",
        input: "cancel and refund",
        candidate_output: "billing",
        status: "not_scored",
        main_score: null,
        scores: [
          {
            scorer_name: "routing-accuracy",
            scorer_version: "v3",
            numeric_value: null,
            error: "KeyError",
          },
          {
            scorer_name: "helpfulness",
            scorer_version: "v2",
            numeric_value: null,
            error: "timeout",
          },
        ],
      }),
      params(runId),
    );

    expect(fakePrisma.evaluationResult.rows).toHaveLength(4);

    // Task error and scorer error are stored on different columns.
    const errored = fakePrisma.evaluationResult.rows.find((r) => r.testCaseId === "case-2")!;
    expect(errored.status).toBe("errored");
    expect(errored.candidateOutput).toBeNull();
    expect(errored.taskError).toContain("ToolTimeout");
    expect(fakePrisma.score.rows.filter((s) => s.resultId === errored.id)).toHaveLength(0);

    const scorerErrRow = fakePrisma.evaluationResult.rows.find((r) => r.testCaseId === "case-3")!;
    expect(scorerErrRow.status).toBe("passed");
    expect(scorerErrRow.mainScore).toBe(1);
    const scorerErrScores = fakePrisma.score.rows.filter((s) => s.resultId === scorerErrRow.id);
    expect(scorerErrScores.find((s) => s.scorerName === "helpfulness")!.error).toContain("JSON");

    const notScored = fakePrisma.evaluationResult.rows.find((r) => r.testCaseId === "case-4")!;
    expect(notScored.status).toBe("not_scored");
    expect(notScored.mainScore).toBeNull();
    expect(
      fakePrisma.score.rows.filter((s) => s.resultId === notScored.id).every((s) => s.error),
    ).toBe(true);

    // 3. Idempotent re-report of case-1 replaces its scores, no duplicate row.
    await upsertResult(
      req({
        test_case_id: "case-1",
        trace_id: "trace-aaa",
        input: "double charge refund?",
        candidate_output: "billing",
        status: "passed",
        main_score: 1,
        scores: [{ scorer_name: "routing-accuracy", scorer_version: "v3", numeric_value: 1 }],
      }),
      params(runId),
    );
    expect(fakePrisma.evaluationResult.rows.filter((r) => r.testCaseId === "case-1")).toHaveLength(
      1,
    );
    let case1 = fakePrisma.evaluationResult.rows.find((r) => r.testCaseId === "case-1")!;
    expect(fakePrisma.score.rows.filter((s) => s.resultId === case1.id)).toHaveLength(1);
    // A caller omitting expected_output/change (both sent on the original report,
    // 2a) must not wipe them: an unsent field keeps its stored value.
    expect(case1.expectedOutput).toBe("billing");
    expect(case1.change).toBe("improved");

    // 3b. A follow-up that omits `scores` entirely (not even `[]`) must leave the
    // previously-reported scores untouched — only a caller-sent `scores` array
    // (including an explicit `[]`) may replace them.
    await upsertResult(
      req({
        test_case_id: "case-1",
        input: "double charge refund?",
        status: "passed",
      }),
      params(runId),
    );
    case1 = fakePrisma.evaluationResult.rows.find((r) => r.testCaseId === "case-1")!;
    expect(fakePrisma.score.rows.filter((s) => s.resultId === case1.id)).toHaveLength(1);
    expect(case1.expectedOutput).toBe("billing");
    expect(case1.change).toBe("improved");
    expect(case1.traceId).toBe("trace-aaa");

    // 4. Out-of-order trace: a result reported without a trace, then linked later.
    await upsertResult(
      req({ test_case_id: "case-5", input: "where is my order", status: "passed", scores: [] }),
      params(runId),
    );
    let case5 = fakePrisma.evaluationResult.rows.find((r) => r.testCaseId === "case-5")!;
    expect(case5.traceId).toBeNull();
    await upsertResult(
      req({
        test_case_id: "case-5",
        trace_id: "trace-eee",
        input: "where is my order",
        status: "passed",
        scores: [],
      }),
      params(runId),
    );
    case5 = fakePrisma.evaluationResult.rows.find((r) => r.testCaseId === "case-5")!;
    expect(case5.traceId).toBe("trace-eee");
    expect(fakePrisma.evaluationResult.rows.filter((r) => r.testCaseId === "case-5")).toHaveLength(
      1,
    );

    // 5. Complete the run with final completeness counts.
    const done = await completeRun(
      req({
        status: "completed_with_errors",
        main_score: 93.8,
        case_count: 24,
        scored_count: 22,
        task_error_count: 1,
        scorer_error_count: 1,
      }),
      params(runId),
    );
    expect(done.status).toBe(200);
    const run = fakePrisma.evaluationRun.rows.find((r) => r.id === runId)!;
    expect(run.status).toBe("completed_with_errors");
    expect(run.scoredCount).toBe(22);
    expect(run.caseCount).toBe(24);
    expect(run.completedAt).toBeInstanceOf(Date);
  });
});

describe("SDK reporting: concurrent registration", () => {
  it("never assigns two runs the same run_number when two registrations race", async () => {
    // Every fake-prisma method is async, so two registerRun calls driven with
    // Promise.all genuinely interleave at the awaits between the run_number
    // read and the insert — the same race a real database sees under READ
    // COMMITTED. uq_run_evaluation_run_number must catch whichever one loses
    // (the route's retry loop replays it), not let both insert run_number 1.
    const register = () =>
      registerRun(
        req({
          evaluation_name: "Concurrent eval",
          dataset_id: "ds1",
          candidate_version: "git:abc123",
        }),
      );
    const [a, b] = await Promise.all([register(), register()]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const [aBody, bBody] = await Promise.all([readJson(a), readJson(b)]);

    // One evaluation lineage, two distinct runs, no run_number collision.
    expect(fakePrisma.evaluation.rows).toHaveLength(1);
    expect(fakePrisma.evaluationRun.rows).toHaveLength(2);
    expect(aBody.evaluation_run_id).not.toBe(bBody.evaluation_run_id);
    expect(new Set([aBody.run_number, bBody.run_number])).toEqual(new Set([1, 2]));
  });
});
