/**
 * Scorer catalog: the route reads the project's raw Score rows plus run manifests in
 * ONE pair of queries and hands them to the pure aggregator — a scorer's identity, its
 * declared config and its usage are all DERIVED from what the SDK reported, never
 * invented here. Auth + Prisma are mocked; the aggregator is the real one.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  score: { findMany: vi.fn() },
  evaluationRun: { findMany: vi.fn() },
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
import type { ScorerRow } from "@/lib/eval/scorer-registry";

const params = { params: Promise.resolve({ projectId: "p1" }) };

function scoreRow(over: Record<string, unknown> = {}) {
  return {
    scorerName: "accuracy",
    scorerVersion: "v1",
    numericValue: 1,
    boolValue: null,
    stringValue: null,
    passed: true,
    error: null,
    createTime: new Date("2026-07-21T00:00:00Z"),
    result: { runId: "run_1", evaluationId: "eval_1" },
    ...over,
  };
}

async function rows(res: { json: () => Promise<unknown> }) {
  return ((await res.json()) as { data: ScorerRow[] }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.evaluationRun.findMany.mockResolvedValue([]);
});

it("aggregates observed scores into one row per (name, version) with usage and pass rate", async () => {
  prismaMock.score.findMany.mockResolvedValue([
    scoreRow(),
    scoreRow({
      numericValue: 0,
      passed: false,
      result: { runId: "run_2", evaluationId: "eval_1" },
    }),
    scoreRow({ scorerVersion: "v2" }),
  ]);

  const res = await GET({} as never, params);
  expect(res.status).toBe(200);
  const data = await rows(res);
  expect(data.map((r) => `${r.name}@${r.version}`)).toEqual(["accuracy@v1", "accuracy@v2"]);

  const v1 = data[0];
  expect(v1.scoreCount).toBe(2);
  expect(v1.valueType).toBe("numeric");
  expect(v1.passRate).toBe(0.5);
  expect(v1.runCount).toBe(2);
  expect(v1.evaluationCount).toBe(1);
  expect(v1.source).toBe("SDK");
  // Exactly two queries — the catalog is never built per-scorer.
  expect(prismaMock.score.findMany).toHaveBeenCalledTimes(1);
  expect(prismaMock.evaluationRun.findMany).toHaveBeenCalledTimes(1);
});

it("carries the SDK-declared config through from the run manifests", async () => {
  prismaMock.score.findMany.mockResolvedValue([scoreRow()]);
  prismaMock.evaluationRun.findMany.mockResolvedValue([
    {
      scorers: [
        {
          name: "accuracy",
          version: "v1",
          value_type: "numeric",
          direction: "higher_is_better",
          threshold: 0.8,
        },
      ],
    },
  ]);

  const v1 = (await rows(await GET({} as never, params)))[0];
  expect(v1.declaredValueType).toBe("numeric");
  expect(v1.direction).toBe("higher_is_better");
  expect(v1.threshold).toBe(0.8);
});

it("surfaces scorer errors and tolerates a score with no linked result", async () => {
  prismaMock.score.findMany.mockResolvedValue([
    scoreRow({ numericValue: null, error: "judge timed out", result: null }),
  ]);

  const v1 = (await rows(await GET({} as never, params)))[0];
  expect(v1.errorCount).toBe(1);
  expect(v1.recentErrors[0].message).toBe("judge timed out");
  // A score whose result row is absent contributes no run/evaluation usage.
  expect(v1.runCount).toBe(0);
  expect(v1.evaluationCount).toBe(0);
});

it("returns an empty catalog for a project that has never scored", async () => {
  prismaMock.score.findMany.mockResolvedValue([]);
  expect(await rows(await GET({} as never, params))).toEqual([]);
});

it("scopes both queries to the project", async () => {
  prismaMock.score.findMany.mockResolvedValue([]);
  await GET({} as never, params);
  expect(prismaMock.score.findMany.mock.calls[0][0].where).toEqual({ projectId: "p1" });
  expect(prismaMock.evaluationRun.findMany.mock.calls[0][0].where).toEqual({ projectId: "p1" });
});

it("401s an unauthenticated caller before touching the database", async () => {
  auth.requireAuth.mockResolvedValue({
    error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
  });
  expect((await GET({} as never, params)).status).toBe(401);
  expect(prismaMock.score.findMany).not.toHaveBeenCalled();
});

it("403s a caller without project access", async () => {
  auth.requireProjectAccess.mockResolvedValue({
    error: { status: 403, json: async () => ({ error: "Forbidden" }) },
  });
  expect((await GET({} as never, params)).status).toBe(403);
  expect(prismaMock.score.findMany).not.toHaveBeenCalled();
});
