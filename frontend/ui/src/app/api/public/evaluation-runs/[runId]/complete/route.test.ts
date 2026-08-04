import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeEvalStore,
  prismaFacade,
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
  prisma: prismaFacade(() => store),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

const params = { params: Promise.resolve({ runId: "run-1" }) };

const FINISHED = {
  status: "completed",
  main_score: 0.9,
  case_count: 10,
  scored_count: 10,
  task_error_count: 0,
  scorer_error_count: 0,
};

function storedRun(): Row {
  return store.evaluationRun.rows[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T12:00:00.000Z"));
  store = makeEvalStore();
  store.evaluationRun.rows.push({
    id: "run-1",
    projectId: "proj-1",
    status: "running",
    completedAt: null,
    caseCount: 10,
    scoredCount: 0,
    // Registered without a resolved main-score name (the B1 flow); tests that need a
    // name fixed at registration override this.
    mainScoreName: null,
  });
  requireApiKeyProjectMock.mockReset();
  requireApiKeyProjectMock.mockResolvedValue({ projectId: "proj-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/public/evaluation-runs/[runId]/complete", () => {
  it("completes a running run and stamps completedAt", async () => {
    const res = await POST(makeRequest(FINISHED), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evaluation_run_id: "run-1", status: "completed" });
    expect(storedRun()).toMatchObject({
      status: "completed",
      scoredCount: 10,
      completedAt: new Date("2026-07-31T12:00:00.000Z"),
    });
  });

  it("keeps the first completion timestamp when the SDK retries", async () => {
    await POST(makeRequest(FINISHED), params);

    vi.setSystemTime(new Date("2026-07-31T12:05:00.000Z"));
    const res = await POST(makeRequest(FINISHED), params);

    expect(res.status).toBe(200);
    // A moving completedAt would silently stretch the run's reported duration.
    expect(storedRun()).toMatchObject({
      status: "completed",
      completedAt: new Date("2026-07-31T12:00:00.000Z"),
    });
  });

  it("refuses to move a finished run back to running", async () => {
    await POST(makeRequest(FINISHED), params);

    const res = await POST(makeRequest({ status: "running" }), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Run is already completed and cannot be reopened",
    });
    // Status and completedAt must not end up describing different things.
    expect(storedRun()).toMatchObject({
      status: "completed",
      completedAt: new Date("2026-07-31T12:00:00.000Z"),
    });
  });

  it("accepts a still-running heartbeat on a run that has not finished", async () => {
    const res = await POST(makeRequest({ status: "running", scored_count: 4 }), params);

    expect(res.status).toBe(200);
    expect(storedRun()).toMatchObject({ status: "running", completedAt: null, scoredCount: 4 });
  });

  it("leaves counts the caller omitted untouched", async () => {
    await POST(makeRequest(FINISHED), params);

    await POST(makeRequest({ status: "completed_with_errors" }), params);

    expect(storedRun()).toMatchObject({
      status: "completed_with_errors",
      caseCount: 10,
      scoredCount: 10,
      completedAt: new Date("2026-07-31T12:00:00.000Z"),
    });
  });

  it("rejects a run owned by another project", async () => {
    requireApiKeyProjectMock.mockResolvedValue({ projectId: "proj-2" });

    const res = await POST(makeRequest(FINISHED), params);

    expect(res.status).toBe(404);
    expect(storedRun()).toMatchObject({ status: "running", completedAt: null });
  });
});

// B1 — resolving the run-level main-score name at completion. `EvaluationRun.mainScoreName`
// is the authoritative run-specific selection; these cover registration-first vs
// completion-first resolution, conflicts, the successful-run existence check, and the
// honest-terminal-state escape hatch. Score rows carry a flat `runId` because the fake
// store flattens the `{ result: { runId } }` relation filter one level.
function addScore(scorerName: string) {
  store.score.rows.push({ scorerName, runId: "run-1", projectId: "proj-1" });
}

describe("POST complete — main score name resolution (B1)", () => {
  it("resolves an unnamed run's main score at completion and persists it", async () => {
    addScore("quality");
    const res = await POST(makeRequest({ ...FINISHED, main_score_name: "quality" }), params);

    expect(res.status).toBe(200);
    // The run now carries the resolved name — the authoritative run-level selection the
    // read model reads back and the headline/comparison label from.
    expect(storedRun()).toMatchObject({ status: "completed", mainScoreName: "quality" });
  });

  it("accepts a completion name that matches the one fixed at registration (idempotent)", async () => {
    storedRun().mainScoreName = "accuracy";
    addScore("accuracy");

    const first = await POST(makeRequest({ ...FINISHED, main_score_name: "accuracy" }), params);
    const second = await POST(makeRequest({ ...FINISHED, main_score_name: "accuracy" }), params);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(storedRun()).toMatchObject({ status: "completed", mainScoreName: "accuracy" });
  });

  it("rejects a completion name that conflicts with registration, without mutating the run", async () => {
    storedRun().mainScoreName = "accuracy";

    const res = await POST(makeRequest({ ...FINISHED, main_score_name: "quality" }), params);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already "accuracy".*cannot be changed/i);
    // Original selection unchanged and the run is untouched (still running).
    expect(storedRun()).toMatchObject({
      status: "running",
      mainScoreName: "accuracy",
      completedAt: null,
    });
  });

  it("rejects a successful completion whose name is absent from every emitted score", async () => {
    addScore("quality"); // the only emitted metric

    const res = await POST(makeRequest({ ...FINISHED, main_score_name: "not_emitted" }), params);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not found among this run's emitted scores/i);
    // Not mutated — the run stays open so it can be completed honestly.
    expect(storedRun()).toMatchObject({ status: "running", mainScoreName: null });
  });

  it("lets an all-scorer-error run reach a failed terminal state with no resolved name", async () => {
    const res = await POST(
      makeRequest({
        status: "failed",
        case_count: 3,
        scored_count: 0,
        scorer_error_count: 3,
      }),
      params,
    );

    expect(res.status).toBe(200);
    // Terminal failure persists (not stranded), and no name was invented.
    expect(storedRun()).toMatchObject({
      status: "failed",
      mainScoreName: null,
      completedAt: new Date("2026-07-31T12:00:00.000Z"),
    });
  });

  it("preserves existing behavior for an old payload that omits main_score_name", async () => {
    // Registered with a name, but no matching score row exists — an older SDK's
    // completion (no main_score_name) must still succeed and must not run the new
    // existence check.
    storedRun().mainScoreName = "accuracy";

    const res = await POST(makeRequest(FINISHED), params);

    expect(res.status).toBe(200);
    expect(storedRun()).toMatchObject({ status: "completed", mainScoreName: "accuracy" });
  });
});
