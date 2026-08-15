import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeEvalStore,
  prismaFacade,
  uniqueViolation,
  type EvalStore,
  type Row,
} from "@/app/api/public/__tests__/eval-store";

let store: EvalStore;
const requireApiKeyProjectMock = vi.fn();

vi.mock("@/lib/eval/auth", () => ({
  requireApiKeyProject: (...args: unknown[]) => requireApiKeyProjectMock(...args),
}));

vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The real contract schemas are kept — absent-vs-explicit-null is the thing
  // under test, and a hand-written stub schema could not exercise it.
  prisma: prismaFacade(() => store),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

const params = { params: Promise.resolve({ runId: "run-1" }) };

/** The full first report the SDK sends once a case has run and been scored. */
function firstReport() {
  return {
    test_case_id: "case-1",
    input: "what is 2+2?",
    status: "passed",
    trace_id: "trace-aaa",
    cost: 0.012,
    expected_output: "4",
    candidate_output: "4",
    duration_ms: 900,
    change: "improved",
    main_score: 1,
    scores: [{ scorer_name: "exact_match", scorer_version: "1", numeric_value: 1 }],
  };
}

function storedResult(): Row {
  expect(store.evaluationResult.rows).toHaveLength(1);
  return store.evaluationResult.rows[0];
}

beforeEach(() => {
  store = makeEvalStore();
  store.evaluationRun.rows.push({
    id: "run-1",
    projectId: "proj-1",
    evaluationId: "eval-1",
    status: "running",
  });
  requireApiKeyProjectMock.mockReset();
  requireApiKeyProjectMock.mockResolvedValue({ projectId: "proj-1" });
});

describe("POST /api/public/evaluation-runs/[runId]/results — first report", () => {
  it("creates the result and its scores", async () => {
    const res = await POST(makeRequest(firstReport()), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evaluation_result_id: "result-1" });
    expect(storedResult()).toMatchObject({
      runId: "run-1",
      evaluationId: "eval-1",
      projectId: "proj-1",
      testCaseId: "case-1",
      traceId: "trace-aaa",
      cost: 0.012,
      status: "passed",
    });
    expect(store.score.rows).toHaveLength(1);
    expect(store.score.rows[0]).toMatchObject({ scorerName: "exact_match", numericValue: 1 });
  });

  it("stores absent optional fields as null on the create path", async () => {
    await POST(makeRequest({ test_case_id: "case-1", input: "in", status: "not_scored" }), params);

    expect(storedResult()).toMatchObject({ traceId: null, cost: null, expectedOutput: null });
  });

  it("keys the write on the (run, test case) unique constraint, not a read-then-write", async () => {
    const upsert = vi.spyOn(store.evaluationResult, "upsert");
    const findFirst = vi.spyOn(store.evaluationResult, "findFirst");

    await POST(makeRequest(firstReport()), params);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId_testCaseId: { runId: "run-1", testCaseId: "case-1" } },
      }),
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rejects a run owned by another project", async () => {
    requireApiKeyProjectMock.mockResolvedValue({ projectId: "proj-2" });

    const res = await POST(makeRequest(firstReport()), params);

    expect(res.status).toBe(404);
    expect(store.evaluationResult.rows).toHaveLength(0);
  });
});

describe("POST … /results — a follow-up report only writes what it sent", () => {
  it("leaves existing scores alone when the body omits `scores`", async () => {
    await POST(makeRequest(firstReport()), params);

    // The trace-linking call the issue describes: minimal, no `scores` key.
    const res = await POST(
      makeRequest({
        test_case_id: "case-1",
        input: "what is 2+2?",
        status: "passed",
        trace_id: "trace-bbb",
      }),
      params,
    );

    expect(res.status).toBe(200);
    expect(store.score.rows).toHaveLength(1);
    expect(store.score.rows[0]).toMatchObject({ scorerName: "exact_match", numericValue: 1 });
    expect(storedResult()).toMatchObject({ traceId: "trace-bbb" });
  });

  it("clears the scores when the body sends an explicit empty `scores`", async () => {
    await POST(makeRequest(firstReport()), params);

    await POST(
      makeRequest({
        test_case_id: "case-1",
        input: "what is 2+2?",
        status: "passed",
        scores: [],
      }),
      params,
    );

    expect(store.score.rows).toHaveLength(0);
  });

  it("replaces the scores when the body sends a new list", async () => {
    await POST(makeRequest(firstReport()), params);

    await POST(
      makeRequest({
        test_case_id: "case-1",
        input: "what is 2+2?",
        status: "passed",
        scores: [{ scorer_name: "judge", scorer_version: "2", numeric_value: 0.5 }],
      }),
      params,
    );

    expect(store.score.rows).toHaveLength(1);
    expect(store.score.rows[0]).toMatchObject({ scorerName: "judge", numericValue: 0.5 });
  });

  it("does not null trace_id, cost, expected_output or change when they are omitted", async () => {
    await POST(makeRequest(firstReport()), params);

    // The scorer finished late: same case, updated score, nothing else known.
    const res = await POST(
      makeRequest({
        test_case_id: "case-1",
        input: "what is 2+2?",
        status: "failed",
        scores: [{ scorer_name: "exact_match", scorer_version: "1", numeric_value: 0 }],
      }),
      params,
    );

    expect(res.status).toBe(200);
    expect(storedResult()).toMatchObject({
      status: "failed",
      traceId: "trace-aaa",
      cost: 0.012,
      expectedOutput: "4",
      candidateOutput: "4",
      change: "improved",
      durationMs: 900,
      mainScore: 1,
    });
  });

  it("still clears a field the caller explicitly sends as null", async () => {
    await POST(makeRequest(firstReport()), params);

    await POST(
      makeRequest({
        test_case_id: "case-1",
        input: "what is 2+2?",
        status: "passed",
        trace_id: null,
        cost: null,
      }),
      params,
    );

    expect(storedResult()).toMatchObject({ traceId: null, cost: null, expectedOutput: "4" });
  });

  it("updates in place rather than inserting a second row for the same test case", async () => {
    await POST(makeRequest(firstReport()), params);
    const res = await POST(makeRequest(firstReport()), params);

    expect(await res.json()).toEqual({ evaluation_result_id: "result-1" });
    expect(store.evaluationResult.rows).toHaveLength(1);
  });
});

describe("POST … /results — concurrency and failure", () => {
  it("converges on a P2002 from a concurrent report instead of returning 500", async () => {
    // Both requests saw no row and both tried to insert; this one lost.
    store.evaluationResult.failNextWrite(uniqueViolation("run_id, test_case_id"));
    store.evaluationResult.rows.push({
      id: "result-9",
      runId: "run-1",
      testCaseId: "case-1",
      projectId: "proj-1",
      traceId: "trace-aaa",
    });

    const res = await POST(
      makeRequest({ test_case_id: "case-1", input: "in", status: "passed", cost: 0.5 }),
      params,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evaluation_result_id: "result-9" });
    expect(store.evaluationResult.rows).toHaveLength(1);
    expect(storedResult()).toMatchObject({ traceId: "trace-aaa", cost: 0.5 });
  });

  it("returns a JSON 500 rather than leaking a database error", async () => {
    store.evaluationResult.failNextWrite(new Error("connection terminated unexpectedly"));

    const res = await POST(makeRequest(firstReport()), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to record result" });
  });
});

describe("POST … /results — validation", () => {
  it("rejects a body that reports the same scorer twice", async () => {
    const res = await POST(
      makeRequest({
        test_case_id: "case-1",
        input: "in",
        status: "passed",
        scores: [
          { scorer_name: "judge", scorer_version: "1", numeric_value: 1 },
          { scorer_name: "judge", scorer_version: "1", numeric_value: 0 },
        ],
      }),
      params,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "scores contains a duplicate (scorer_name, scorer_version)",
    });
    expect(store.evaluationResult.rows).toHaveLength(0);
  });
});
