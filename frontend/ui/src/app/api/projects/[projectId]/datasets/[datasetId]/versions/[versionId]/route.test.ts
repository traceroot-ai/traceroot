/**
 * Reading one immutable dataset version. The lookup is scoped by dataset AND project,
 * so a version id from another dataset or project reads as "not found" rather than
 * leaking a snapshot. Auth + Prisma are mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  datasetVersion: { findFirst: vi.fn() },
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

const params = {
  params: Promise.resolve({ projectId: "p1", datasetId: "ds1", versionId: "dv1" }),
};

async function body(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
});

it("returns the cases with input/expected decoded for display, oldest first", async () => {
  // Stored values are JSON-ENCODED; the response decodes them so this view matches
  // the current-version view (not the raw quoted form). (M7)
  const stored = [
    { id: "row1", testCaseId: "case-1", input: '"hello"', expected: "42" },
    { id: "row2", testCaseId: "case-2", input: '{"a":1}', expected: null },
  ];
  prismaMock.datasetVersion.findFirst.mockResolvedValue({
    id: "dv1",
    datasetId: "ds1",
    versionNumber: 1,
    label: "v1",
    testCases: stored,
  });

  const res = await GET({} as never, params);
  const b = await body(res);
  expect(res.status).toBe(200);
  expect((b.version as { label: string }).label).toBe("v1");
  const cases = b.testCases as Array<Record<string, unknown>>;
  expect(cases[0]).toMatchObject({ testCaseId: "case-1", input: "hello", expected: "42" });
  expect(cases[1]).toMatchObject({ testCaseId: "case-2", input: '{\n  "a": 1\n}', expected: null });
  expect(prismaMock.datasetVersion.findFirst).toHaveBeenCalledWith({
    where: { id: "dv1", datasetId: "ds1", projectId: "p1" },
    // Tiebroken on testCaseId (TEST_CASE_ORDER): a batch pushed in one SDK call
    // shares a createTime, so createTime alone leaves their order to the database.
    include: {
      testCases: { orderBy: [{ createTime: "asc" }, { testCaseId: "asc" }] },
    },
  });
});

it("returns an empty case list for a version that snapshotted nothing", async () => {
  prismaMock.datasetVersion.findFirst.mockResolvedValue({ id: "dv1", label: "v1", testCases: [] });
  expect((await body(await GET({} as never, params))).testCases).toEqual([]);
});

it("404s a version that does not belong to this dataset/project", async () => {
  prismaMock.datasetVersion.findFirst.mockResolvedValue(null);
  const res = await GET({} as never, params);
  expect(res.status).toBe(404);
  expect(await body(res)).toEqual({ error: "Dataset version not found" });
});

it("401s an unauthenticated caller before touching the database", async () => {
  auth.requireAuth.mockResolvedValue({
    error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
  });
  expect((await GET({} as never, params)).status).toBe(401);
  expect(prismaMock.datasetVersion.findFirst).not.toHaveBeenCalled();
});

it("403s a caller without project access", async () => {
  auth.requireProjectAccess.mockResolvedValue({
    error: { status: 403, json: async () => ({ error: "Forbidden" }) },
  });
  expect((await GET({} as never, params)).status).toBe(403);
  expect(prismaMock.datasetVersion.findFirst).not.toHaveBeenCalled();
});
