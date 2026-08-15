/**
 * Dataset detail route: reading a dataset resolves WHICH immutable version is being
 * viewed (`?version_id=`, falling back to current), presents stored JSON-encoded
 * test-case values as human text, and edits/deletes touch only the dataset's own
 * metadata — never a published snapshot. Auth + Prisma are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  dataset: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  testCase: { findMany: vi.fn() },
  // A dataset with runs against it can't be deleted — the runs' FK still points at
  // its versions, and the history would read as if those runs never happened.
  evaluationRun: { count: vi.fn() },
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

import { GET, PATCH, DELETE } from "./route";

const params = { params: Promise.resolve({ projectId: "p1", datasetId: "ds1" }) };

const getReq = (qs = "") =>
  ({ nextUrl: { searchParams: new URLSearchParams(qs) } }) as unknown as Parameters<typeof GET>[0];
const jsonReq = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof PATCH>[0];
const badJsonReq = () =>
  ({
    json: async () => {
      throw new Error("bad json");
    },
  }) as unknown as Parameters<typeof PATCH>[0];

const v1 = { id: "dv1", datasetId: "ds1", versionNumber: 1, label: "v1" };
const v2 = { id: "dv2", datasetId: "ds1", versionNumber: 2, label: "v2" };

function dataset(over: Record<string, unknown> = {}) {
  return {
    id: "ds1",
    projectId: "p1",
    name: "support",
    currentVersionId: "dv2",
    versions: [v2, v1],
    ...over,
  };
}

async function body(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.testCase.findMany.mockResolvedValue([]);
  prismaMock.evaluationRun.count.mockResolvedValue(0);
});

describe("GET", () => {
  it("returns the current version, its cases (newest first), and the version list", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(dataset());
    prismaMock.testCase.findMany.mockResolvedValue([
      { id: "row1", testCaseId: "case-1", input: '"a ticket"', expected: '"billing"' },
    ]);

    const res = await GET(getReq(), params);
    const b = await body(res);
    expect(res.status).toBe(200);
    expect(b.selectedVersion).toEqual(v2);
    expect(b.currentVersion).toEqual(v2);
    expect(b.isCurrentVersion).toBe(true);
    expect(b.versions).toEqual([v2, v1]);
    // Cases are read from the SELECTED version only.
    expect(prismaMock.testCase.findMany).toHaveBeenCalledWith({
      where: { datasetVersionId: "dv2" },
      // Tiebroken on testCaseId: cases pushed in one SDK call share a createTime,
      // so without it their order is whatever the database happens to return.
      orderBy: [{ createTime: "desc" }, { testCaseId: "desc" }],
    });
  });

  it("presents stored JSON values as human text, never as a bare quoted string", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(dataset());
    prismaMock.testCase.findMany.mockResolvedValue([
      { testCaseId: "c1", input: '"a ticket"', expected: '{"label":"billing"}' },
      { testCaseId: "c2", input: '"x"', expected: null },
    ]);

    const b = await body(await GET(getReq(), params));
    const cases = b.testCases as Array<Record<string, unknown>>;
    expect(cases[0].input).toBe("a ticket"); // unquoted
    expect(cases[0].expected).toBe('{\n  "label": "billing"\n}'); // pretty JSON
    expect(cases[1].expected).toBeNull(); // null stays null, not ""
  });

  it("views an older snapshot when ?version_id= names one of this dataset's versions", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(dataset());

    const b = await body(await GET(getReq("version_id=dv1"), params));
    expect(b.selectedVersion).toEqual(v1);
    expect(b.isCurrentVersion).toBe(false);
    expect(prismaMock.testCase.findMany).toHaveBeenCalledWith({
      where: { datasetVersionId: "dv1" },
      // Tiebroken on testCaseId: cases pushed in one SDK call share a createTime,
      // so without it their order is whatever the database happens to return.
      orderBy: [{ createTime: "desc" }, { testCaseId: "desc" }],
    });
  });

  it("falls back to the current version when ?version_id= is unknown", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(dataset());

    const b = await body(await GET(getReq("version_id=dv_other_dataset"), params));
    expect(b.selectedVersion).toEqual(v2);
    expect(b.isCurrentVersion).toBe(true);
  });

  it("reports no selected version (and reads no cases) for a dataset with none", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(
      dataset({ currentVersionId: null, versions: [] }),
    );

    const b = await body(await GET(getReq(), params));
    expect(b.selectedVersion).toBeNull();
    expect(b.currentVersion).toBeNull();
    expect(b.testCases).toEqual([]);
    expect(prismaMock.testCase.findMany).not.toHaveBeenCalled();
  });

  it("404s an unknown dataset", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(null);
    const res = await GET(getReq(), params);
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: "Dataset not found" });
  });

  it("401s an unauthenticated caller before touching the database", async () => {
    auth.requireAuth.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = await GET(getReq(), params);
    expect(res.status).toBe(401);
    expect(prismaMock.dataset.findFirst).not.toHaveBeenCalled();
  });

  it("403s a caller without project access", async () => {
    auth.requireProjectAccess.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = await GET(getReq(), params);
    expect(res.status).toBe(403);
    expect(prismaMock.dataset.findFirst).not.toHaveBeenCalled();
  });
});

describe("PATCH", () => {
  it("updates only the fields present in the body", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1" });
    prismaMock.dataset.update.mockResolvedValue({ id: "ds1", name: "renamed" });

    const res = await PATCH(jsonReq({ name: "renamed" }), params);
    expect(res.status).toBe(200);
    expect((await body(res)).dataset).toMatchObject({ name: "renamed" });
    expect(prismaMock.dataset.update).toHaveBeenCalledWith({
      where: { id: "ds1" },
      data: { name: "renamed" }, // description untouched, not nulled
    });
  });

  it("clears the description when it is explicitly null", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1" });
    prismaMock.dataset.update.mockResolvedValue({ id: "ds1" });

    await PATCH(jsonReq({ description: null }), params);
    expect(prismaMock.dataset.update).toHaveBeenCalledWith({
      where: { id: "ds1" },
      data: { description: null },
    });
  });

  it("400s an unparseable body", async () => {
    const res = await PATCH(badJsonReq(), params);
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: "Invalid JSON" });
  });

  it("400s a body that fails the contract schema", async () => {
    const res = await PATCH(jsonReq({ name: "" }), params);
    expect(res.status).toBe(400);
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
  });

  it("404s an unknown dataset without updating", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(null);
    const res = await PATCH(jsonReq({ name: "renamed" }), params);
    expect(res.status).toBe(404);
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller", async () => {
    auth.requireAuth.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    expect((await PATCH(jsonReq({ name: "x" }), params)).status).toBe(401);
  });

  it("403s a viewer without write access", async () => {
    auth.requireProjectAccess.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    expect((await PATCH(jsonReq({ name: "x" }), params)).status).toBe(403);
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
  });
});

describe("DELETE", () => {
  it("deletes a dataset that belongs to the project", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1" });
    prismaMock.dataset.delete.mockResolvedValue({ id: "ds1" });

    const res = await DELETE({} as never, params);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ deleted: true });
    expect(prismaMock.dataset.delete).toHaveBeenCalledWith({ where: { id: "ds1" } });
  });

  it("404s an unknown dataset without deleting", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(null);
    const res = await DELETE({} as never, params);
    expect(res.status).toBe(404);
    expect(prismaMock.dataset.delete).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller", async () => {
    auth.requireAuth.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    expect((await DELETE({} as never, params)).status).toBe(401);
    expect(prismaMock.dataset.delete).not.toHaveBeenCalled();
  });

  it("403s a viewer without write access", async () => {
    auth.requireProjectAccess.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    expect((await DELETE({} as never, params)).status).toBe(403);
    expect(prismaMock.dataset.delete).not.toHaveBeenCalled();
  });
});
