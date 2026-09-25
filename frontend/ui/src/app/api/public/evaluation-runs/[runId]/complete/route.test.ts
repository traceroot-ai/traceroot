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

// A scorer DEFINITION (e.g. `grade`) owns EMITTED METRICS (e.g. `quality`), and which
// ones it emits is only known once the run has run — so registration stores unresolved
// definitions and completion folds the resolved manifest in.
const RESOLVED_GRADE = {
  name: "grade",
  version: "v1",
  emitted_metrics: [
    { name: "quality", value_type: "numeric", direction: "higher_is_better", threshold: 0.5 },
  ],
};

describe("POST complete — resolved scorer manifest", () => {
  it("merges a manifest resolved during the run into the stored one", async () => {
    storedRun().scorers = [{ name: "grade", version: "v1" }]; // registered unresolved

    const res = await POST(makeRequest({ ...FINISHED, scorers: [RESOLVED_GRADE] }), params);

    expect(res.status).toBe(200);
    // The emitted metric and its policy survive the round trip — the whole point of the
    // field; a stripped `emitted_metrics` would silently lose every metric's threshold.
    expect(storedRun().scorers).toEqual([RESOLVED_GRADE]);
  });

  it("keeps definitions the resolved manifest does not mention", async () => {
    storedRun().scorers = [
      { name: "grade", version: "v1" },
      { name: "latency", version: "v2", threshold: 100 },
    ];

    await POST(makeRequest({ ...FINISHED, scorers: [RESOLVED_GRADE] }), params);

    expect(storedRun().scorers).toEqual([
      RESOLVED_GRADE,
      { name: "latency", version: "v2", threshold: 100 },
    ]);
  });

  it("is idempotent across a completion replay", async () => {
    storedRun().scorers = [{ name: "grade", version: "v1" }];

    await POST(makeRequest({ ...FINISHED, scorers: [RESOLVED_GRADE] }), params);
    await POST(makeRequest({ ...FINISHED, scorers: [RESOLVED_GRADE] }), params);

    expect(storedRun().scorers).toEqual([RESOLVED_GRADE]);
  });

  it("leaves the stored manifest alone when an older SDK omits it", async () => {
    storedRun().scorers = [RESOLVED_GRADE];

    await POST(makeRequest(FINISHED), params);

    expect(storedRun().scorers).toEqual([RESOLVED_GRADE]);
  });
});
