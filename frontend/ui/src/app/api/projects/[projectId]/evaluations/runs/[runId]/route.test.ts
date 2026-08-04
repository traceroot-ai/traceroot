/**
 * Run-detail shaping: a baseline delta is only computed when the baseline run
 * measured the identical population (same evaluation + same dataset snapshot);
 * otherwise the UI must get `changeFromBaseline: null` and `baselineComparable:
 * false` so it warns instead of subtracting incompatible numbers.
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

function baseRun(baselineRun: unknown) {
  return {
    id: "run-1",
    projectId: "p1",
    evaluationId: "eval-1",
    datasetId: "ds1",
    datasetVersionId: "dv2",
    mainScore: 90,
    taskErrorCount: 0,
    scorerErrorCount: 0,
    evaluation: { name: "Billing routing" },
    datasetVersion: { label: "v2" },
    baselineRun,
    results: [],
  };
}

beforeEach(() => {
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1", name: "Billing routing" });
});

it("computes a delta when the baseline shares the same evaluation and snapshot", async () => {
  prismaMock.evaluationRun.findFirst.mockResolvedValue(
    baseRun({
      id: "run-0",
      mainScore: 70,
      evaluationId: "eval-1",
      datasetVersionId: "dv2",
      datasetVersion: { label: "v2" },
    }),
  );
  const body = (await (await GET({} as never, params)).json()) as Record<string, never>;
  const run = body.run as unknown as { changeFromBaseline: number; baselineComparable: boolean };
  expect(run.baselineComparable).toBe(true);
  expect(run.changeFromBaseline).toBe(20);
});

it("refuses a delta when the baseline used a different dataset snapshot", async () => {
  prismaMock.evaluationRun.findFirst.mockResolvedValue(
    baseRun({
      id: "run-0",
      mainScore: 70,
      evaluationId: "eval-1",
      datasetVersionId: "dv1", // different snapshot
      datasetVersion: { label: "v1" },
    }),
  );
  const body = (await (await GET({} as never, params)).json()) as Record<string, never>;
  const run = body.run as unknown as {
    changeFromBaseline: number | null;
    baselineComparable: boolean;
  };
  expect(run.baselineComparable).toBe(false);
  expect(run.changeFromBaseline).toBeNull();
});

it("404s an unknown run", async () => {
  prismaMock.evaluationRun.findFirst.mockResolvedValue(null);
  const res = await GET({} as never, params);
  expect(res.status).toBe(404);
});
