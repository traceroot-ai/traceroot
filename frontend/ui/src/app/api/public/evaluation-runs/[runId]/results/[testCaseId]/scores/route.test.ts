import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeEvalStore,
  prismaFacade,
  uniqueViolation,
  type EvalStore,
} from "@/app/api/public/__tests__/eval-store";

let store: EvalStore;
const requireApiKeyProjectMock = vi.fn();

vi.mock("@/lib/eval/auth", () => ({
  requireApiKeyProject: (...args: unknown[]) => requireApiKeyProjectMock(...args),
}));

vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prisma: prismaFacade(() => store),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

const params = { params: Promise.resolve({ runId: "run-1", testCaseId: "case-1" }) };

const judgeScore = {
  scorer_name: "judge",
  scorer_version: "1",
  numeric_value: 0.8,
  explanation: "close enough",
};

beforeEach(() => {
  store = makeEvalStore();
  store.evaluationResult.rows.push({
    id: "result-1",
    runId: "run-1",
    testCaseId: "case-1",
    projectId: "proj-1",
  });
  requireApiKeyProjectMock.mockReset();
  requireApiKeyProjectMock.mockResolvedValue({ projectId: "proj-1" });
});

describe("POST … /results/[testCaseId]/scores", () => {
  it("records a scorer's outcome keyed on the (result, scorer) unique constraint", async () => {
    const upsert = vi.spyOn(store.score, "upsert");
    const findFirst = vi.spyOn(store.score, "findFirst");

    const res = await POST(makeRequest(judgeScore), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ score_id: "score-1" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          resultId_scorerName_scorerVersion: {
            resultId: "result-1",
            scorerName: "judge",
            scorerVersion: "1",
          },
        },
      }),
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("merges a retried report in place instead of duplicating the scorer's row", async () => {
    await POST(makeRequest(judgeScore), params);
    const res = await POST(makeRequest({ ...judgeScore, numeric_value: 0.9 }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ score_id: "score-1" });
    expect(store.score.rows).toHaveLength(1);
    expect(store.score.rows[0]).toMatchObject({ scorerName: "judge", numericValue: 0.9 });
  });

  it("keeps a different scorer version as its own row", async () => {
    await POST(makeRequest(judgeScore), params);
    await POST(makeRequest({ ...judgeScore, scorer_version: "2" }), params);

    expect(store.score.rows).toHaveLength(2);
  });

  it("converges on a P2002 from a concurrent report instead of returning 500", async () => {
    // The concurrent request inserted the row between this one's read and write.
    store.score.failNextWrite(uniqueViolation("result_id, scorer_name, scorer_version"));
    store.score.rows.push({
      id: "score-9",
      resultId: "result-1",
      projectId: "proj-1",
      scorerName: "judge",
      scorerVersion: "1",
      numericValue: 0.1,
    });

    const res = await POST(makeRequest(judgeScore), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ score_id: "score-9" });
    expect(store.score.rows).toHaveLength(1);
    expect(store.score.rows[0]).toMatchObject({ numericValue: 0.8 });
  });

  it("returns a JSON 500 rather than leaking a database error", async () => {
    store.score.failNextWrite(new Error("connection terminated unexpectedly"));

    const res = await POST(makeRequest(judgeScore), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to record score" });
  });

  it("rejects a result owned by another project", async () => {
    requireApiKeyProjectMock.mockResolvedValue({ projectId: "proj-2" });

    const res = await POST(makeRequest(judgeScore), params);

    expect(res.status).toBe(404);
    expect(store.score.rows).toHaveLength(0);
  });
});
