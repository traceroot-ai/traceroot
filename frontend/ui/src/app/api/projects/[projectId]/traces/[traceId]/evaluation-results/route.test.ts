/**
 * Trace → evaluation linkage: the results this trace produced, read from Postgres so
 * the trace panel's Evaluation tab works without ClickHouse. Auth + Prisma are mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationResult: { findMany: vi.fn() },
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

const params = { params: Promise.resolve({ projectId: "p1", traceId: "tr_1" }) };

const result = {
  id: "res_1",
  testCaseId: "case-1",
  traceId: "tr_1",
  status: "passed",
  scores: [{ scorerName: "accuracy", numericValue: 1 }],
  run: {
    id: "run_2",
    runNumber: 2,
    candidateVersion: "sonnet",
    datasetId: "ds1",
    datasetVersionId: "dv2",
    evaluation: { id: "eval_1", name: "ticket-routing" },
    datasetVersion: { label: "v2" },
  },
};

async function rows(res: { json: () => Promise<unknown> }) {
  return ((await res.json()) as { data: Record<string, unknown>[] }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
});

it("returns this trace's results with their scores and owning run", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([result]);

  const res = await GET({} as never, params);
  expect(res.status).toBe(200);
  const data = await rows(res);
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({ id: "res_1", testCaseId: "case-1" });
  expect((data[0].run as { evaluation: { name: string } }).evaluation.name).toBe("ticket-routing");
});

it("scopes the read to project + trace, newest result first", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);
  await GET({} as never, params);

  const args = prismaMock.evaluationResult.findMany.mock.calls[0][0];
  expect(args.where).toEqual({ projectId: "p1", traceId: "tr_1" });
  expect(args.orderBy).toEqual({ createTime: "desc" });
});

it("returns an empty list for a trace no evaluation produced", async () => {
  prismaMock.evaluationResult.findMany.mockResolvedValue([]);
  expect(await rows(await GET({} as never, params))).toEqual([]);
});

it("401s an unauthenticated caller before touching the database", async () => {
  auth.requireAuth.mockResolvedValue({
    error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
  });
  expect((await GET({} as never, params)).status).toBe(401);
  expect(prismaMock.evaluationResult.findMany).not.toHaveBeenCalled();
});

it("403s a caller without project access", async () => {
  auth.requireProjectAccess.mockResolvedValue({
    error: { status: 403, json: async () => ({ error: "Forbidden" }) },
  });
  expect((await GET({} as never, params)).status).toBe(403);
  expect(prismaMock.evaluationResult.findMany).not.toHaveBeenCalled();
});
