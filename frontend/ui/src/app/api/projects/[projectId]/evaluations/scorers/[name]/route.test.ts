/**
 * Scorer-family detail: all versions of one scorer NAME, with a family-level usage
 * union (distinct runs/evaluations, totals, last use) computed across versions. The
 * Score read is narrowed to the name (not the whole project) while manifests are still
 * scanned project-wide, and a name nobody has scored is a 404 — never an empty shell.
 * Auth + Prisma are mocked; the aggregator is the real one.
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

const params = (name = "accuracy") => ({ params: Promise.resolve({ projectId: "p1", name }) });

interface Detail {
  name: string;
  versions: ScorerRow[];
  usage: {
    runCount: number;
    evaluationCount: number;
    scoreCount: number;
    errorCount: number;
    lastUsed: string | null;
  };
  source: string;
}

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

async function detail(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Detail;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.evaluationRun.findMany.mockResolvedValue([]);
});

it("unions usage across the family's versions and lists every version", async () => {
  prismaMock.score.findMany.mockResolvedValue([
    scoreRow(),
    scoreRow({
      scorerVersion: "v2",
      createTime: new Date("2026-07-22T00:00:00Z"),
      result: { runId: "run_2", evaluationId: "eval_2" },
    }),
    // Same run as the first score — distinct-counted, not double-counted.
    scoreRow({ scorerVersion: "v2", createTime: new Date("2026-07-20T00:00:00Z") }),
  ]);

  const res = await GET({} as never, params());
  expect(res.status).toBe(200);
  const b = await detail(res);
  expect(b.name).toBe("accuracy");
  expect(b.source).toBe("SDK");
  expect(b.versions.map((v) => v.version)).toEqual(["v1", "v2"]);
  expect(b.usage).toEqual({
    runCount: 2,
    evaluationCount: 2,
    scoreCount: 3,
    errorCount: 0,
    lastUsed: "2026-07-22T00:00:00.000Z", // the newest across versions
  });
});

it("counts family errors and tolerates scores with no linked result", async () => {
  prismaMock.score.findMany.mockResolvedValue([
    scoreRow({ numericValue: null, error: "judge timed out", result: null }),
    scoreRow(),
  ]);
  const b = await detail(await GET({} as never, params()));
  expect(b.usage.errorCount).toBe(1);
  expect(b.usage.runCount).toBe(1);
});

it("narrows the score read to this scorer name and keeps manifests project-wide", async () => {
  prismaMock.score.findMany.mockResolvedValue([scoreRow()]);
  await GET({} as never, params());
  expect(prismaMock.score.findMany.mock.calls[0][0].where).toEqual({
    projectId: "p1",
    scorerName: "accuracy",
  });
  expect(prismaMock.evaluationRun.findMany.mock.calls[0][0].where).toEqual({ projectId: "p1" });
});

it("decodes a URL-encoded scorer name from the path", async () => {
  prismaMock.score.findMany.mockResolvedValue([scoreRow({ scorerName: "answer relevance" })]);
  const b = await detail(await GET({} as never, params("answer%20relevance")));
  expect(b.name).toBe("answer relevance");
  expect(prismaMock.score.findMany.mock.calls[0][0].where.scorerName).toBe("answer relevance");
  expect(b.versions).toHaveLength(1);
});

it("excludes other scorer families the aggregator may see via manifests", async () => {
  prismaMock.score.findMany.mockResolvedValue([scoreRow()]);
  prismaMock.evaluationRun.findMany.mockResolvedValue([
    { scorers: [{ name: "toxicity", version: "v1", direction: "lower_is_better" }] },
  ]);
  const b = await detail(await GET({} as never, params()));
  expect(b.versions.every((v) => v.name === "accuracy")).toBe(true);
});

it("404s a scorer name nobody in the project has scored", async () => {
  prismaMock.score.findMany.mockResolvedValue([]);
  const res = await GET({} as never, params("never-used"));
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Scorer not found" });
});

it("401s an unauthenticated caller before touching the database", async () => {
  auth.requireAuth.mockResolvedValue({
    error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
  });
  expect((await GET({} as never, params())).status).toBe(401);
  expect(prismaMock.score.findMany).not.toHaveBeenCalled();
});

it("403s a caller without project access", async () => {
  auth.requireProjectAccess.mockResolvedValue({
    error: { status: 403, json: async () => ({ error: "Forbidden" }) },
  });
  expect((await GET({} as never, params())).status).toBe(403);
  expect(prismaMock.score.findMany).not.toHaveBeenCalled();
});
