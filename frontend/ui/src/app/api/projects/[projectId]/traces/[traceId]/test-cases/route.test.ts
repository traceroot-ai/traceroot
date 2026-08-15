/**
 * Span → dataset linkage powering the "In <dataset>" chip. A case captured from this
 * trace is reported ONLY while it still lives in its dataset's current version, so an
 * edited case shows its dataset once — not once per historical snapshot it appears in.
 * Auth + Prisma are mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  testCase: { findMany: vi.fn() },
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
const UPDATED = new Date("2026-07-21T00:00:00Z");

/** A captured case; `datasetVersionId` decides whether it is still current. */
function caseRow(over: Record<string, unknown> = {}, versionOver: Record<string, unknown> = {}) {
  return {
    testCaseId: "case-1",
    datasetId: "ds1",
    datasetVersionId: "dv2",
    sourceSpanId: "sp_1",
    review: "ready",
    version: {
      label: "v2",
      _count: { testCases: 12 },
      dataset: { name: "support", currentVersionId: "dv2", updateTime: UPDATED },
      ...versionOver,
    },
    ...over,
  };
}

async function rows(res: { json: () => Promise<unknown> }) {
  return ((await res.json()) as { data: Record<string, unknown>[] }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
});

it("returns a chip row per current-version case captured from this trace", async () => {
  prismaMock.testCase.findMany.mockResolvedValue([caseRow()]);

  const res = await GET({} as never, params);
  expect(res.status).toBe(200);
  expect((await rows(res))[0]).toEqual({
    testCaseId: "case-1",
    datasetId: "ds1",
    datasetName: "support",
    sourceSpanId: "sp_1",
    review: "ready",
    datasetVersionLabel: "v2",
    datasetUpdatedAt: UPDATED.toISOString(),
    caseCount: 12,
  });
});

it("drops a case that only lives in a historical snapshot", async () => {
  prismaMock.testCase.findMany.mockResolvedValue([
    caseRow({ datasetVersionId: "dv1" }, { label: "v1" }), // superseded copy
    caseRow(), // the current one
  ]);
  const data = await rows(await GET({} as never, params));
  expect(data).toHaveLength(1);
  expect(data[0].datasetVersionLabel).toBe("v2");
});

it("reports one row per dataset when a span was captured into two datasets", async () => {
  prismaMock.testCase.findMany.mockResolvedValue([
    caseRow(),
    caseRow(
      { testCaseId: "case-2", datasetId: "ds2", datasetVersionId: "dvB" },
      {
        label: "v5",
        _count: { testCases: 3 },
        dataset: { name: "billing", currentVersionId: "dvB", updateTime: UPDATED },
      },
    ),
  ]);
  const data = await rows(await GET({} as never, params));
  expect(data.map((r) => r.datasetName)).toEqual(["support", "billing"]);
});

it("scopes the read to project + source trace", async () => {
  prismaMock.testCase.findMany.mockResolvedValue([]);
  await GET({} as never, params);
  expect(prismaMock.testCase.findMany.mock.calls[0][0].where).toEqual({
    projectId: "p1",
    sourceTraceId: "tr_1",
  });
});

it("returns an empty list for a trace nothing was captured from", async () => {
  prismaMock.testCase.findMany.mockResolvedValue([]);
  expect(await rows(await GET({} as never, params))).toEqual([]);
});

it("401s an unauthenticated caller before touching the database", async () => {
  auth.requireAuth.mockResolvedValue({
    error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
  });
  expect((await GET({} as never, params)).status).toBe(401);
  expect(prismaMock.testCase.findMany).not.toHaveBeenCalled();
});

it("403s a caller without project access", async () => {
  auth.requireProjectAccess.mockResolvedValue({
    error: { status: 403, json: async () => ({ error: "Forbidden" }) },
  });
  expect((await GET({} as never, params)).status).toBe(403);
  expect(prismaMock.testCase.findMany).not.toHaveBeenCalled();
});
