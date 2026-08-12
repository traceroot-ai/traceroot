/**
 * Dataset list + create. The list pages with clamped bounds, derives each dataset's
 * case count from its CURRENT version via one groupBy (never N per-dataset counts),
 * and reports 0 for a dataset with no version. Auth + Prisma are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  dataset: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
  testCase: { groupBy: vi.fn() },
  $transaction: vi.fn(async (arr: Promise<unknown>[]) => Promise.all(arr)),
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

import { GET, POST } from "./route";

const params = { params: Promise.resolve({ projectId: "p1" }) };

const getReq = (qs = "") =>
  ({ nextUrl: { searchParams: new URLSearchParams(qs) } }) as unknown as Parameters<typeof GET>[0];
const jsonReq = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof POST>[0];
const badJsonReq = () =>
  ({
    json: async () => {
      throw new Error("bad json");
    },
  }) as unknown as Parameters<typeof POST>[0];

function ds(over: Record<string, unknown> = {}) {
  return {
    id: "ds1",
    projectId: "p1",
    name: "support",
    description: null,
    currentVersionId: "dv2",
    _count: { versions: 3 },
    ...over,
  };
}

async function body(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Record<string, unknown>;
}
/** The `findMany` args the route passed inside the transaction. */
const listArgs = () => prismaMock.dataset.findMany.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.$transaction.mockImplementation(async (arr: Promise<unknown>[]) => Promise.all(arr));
  prismaMock.dataset.findMany.mockResolvedValue([]);
  prismaMock.dataset.findFirst.mockResolvedValue(null); // default: name is free to use
  prismaMock.dataset.count.mockResolvedValue(0);
  prismaMock.testCase.groupBy.mockResolvedValue([]);
});

describe("GET", () => {
  it("returns each dataset with its current version's case count and version count", async () => {
    prismaMock.dataset.findMany.mockResolvedValue([
      ds(),
      ds({ id: "ds2", currentVersionId: "dvB" }),
    ]);
    prismaMock.dataset.count.mockResolvedValue(2);
    prismaMock.testCase.groupBy.mockResolvedValue([
      { datasetVersionId: "dv2", _count: { _all: 7 } },
      { datasetVersionId: "dvB", _count: { _all: 0 } },
    ]);

    const res = await GET(getReq(), params);
    const b = await body(res);
    expect(res.status).toBe(200);
    const data = b.data as Record<string, unknown>[];
    expect(data[0]).toMatchObject({ id: "ds1", caseCount: 7, versionCount: 3 });
    expect(data[1]).toMatchObject({ id: "ds2", caseCount: 0 });
    expect(b.meta).toEqual({ page: 0, limit: 50, total: 2 });
    // One groupBy for the whole page, never one count per dataset.
    expect(prismaMock.testCase.groupBy).toHaveBeenCalledTimes(1);
    expect(prismaMock.testCase.groupBy.mock.calls[0][0].where).toEqual({
      datasetVersionId: { in: ["dv2", "dvB"] },
    });
  });

  it("counts 0 for a dataset with no current version and skips it in the groupBy", async () => {
    prismaMock.dataset.findMany.mockResolvedValue([ds({ currentVersionId: null })]);
    prismaMock.dataset.count.mockResolvedValue(1);

    const data = (await body(await GET(getReq(), params))).data as Record<string, unknown>[];
    expect(data[0].caseCount).toBe(0);
    // No version ids at all → the groupBy is skipped entirely.
    expect(prismaMock.testCase.groupBy).not.toHaveBeenCalled();
  });

  it("counts 0 when the current version has no rows in the groupBy result", async () => {
    prismaMock.dataset.findMany.mockResolvedValue([ds()]);
    prismaMock.dataset.count.mockResolvedValue(1);
    prismaMock.testCase.groupBy.mockResolvedValue([]);

    const data = (await body(await GET(getReq(), params))).data as Record<string, unknown>[];
    expect(data[0].caseCount).toBe(0);
  });

  it("pages with the requested limit/page", async () => {
    await GET(getReq("limit=10&page=2"), params);
    expect(listArgs()).toMatchObject({ take: 10, skip: 20 });
  });

  it("clamps a limit above the cap and a negative page", async () => {
    await GET(getReq("limit=5000&page=-4"), params);
    expect(listArgs()).toMatchObject({ take: 200, skip: 0 });
  });

  it("clamps a zero limit up to 1", async () => {
    await GET(getReq("limit=0"), params);
    expect(listArgs().take).toBe(1);
  });

  it("falls back to the defaults for non-numeric paging", async () => {
    const b = await body(await GET(getReq("limit=abc&page=xyz"), params));
    expect(listArgs()).toMatchObject({ take: 50, skip: 0 });
    expect(b.meta).toMatchObject({ page: 0, limit: 50 });
  });

  it("filters on name or description for a search query", async () => {
    await GET(getReq("search_query=%20billing%20"), params);
    expect(listArgs().where).toEqual({
      projectId: "p1",
      OR: [
        { name: { contains: "billing", mode: "insensitive" } },
        { description: { contains: "billing", mode: "insensitive" } },
      ],
    });
  });

  it("ignores a whitespace-only search query", async () => {
    await GET(getReq("search_query=%20%20"), params);
    expect(listArgs().where).toEqual({ projectId: "p1" });
  });

  it("401s an unauthenticated caller before touching the database", async () => {
    auth.requireAuth.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    expect((await GET(getReq(), params)).status).toBe(401);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("403s a caller without project access", async () => {
    auth.requireProjectAccess.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    expect((await GET(getReq(), params)).status).toBe(403);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe("POST", () => {
  it("creates an empty dataset scoped to the project and 201s", async () => {
    prismaMock.dataset.create.mockResolvedValue({ id: "ds_new", name: "support" });

    const res = await POST(jsonReq({ name: "support", description: "tickets" }), params);
    expect(res.status).toBe(201);
    expect((await body(res)).dataset).toMatchObject({ id: "ds_new" });
    expect(prismaMock.dataset.create).toHaveBeenCalledWith({
      data: { projectId: "p1", name: "support", description: "tickets" },
    });
  });

  it("stores a null description when none is given", async () => {
    prismaMock.dataset.create.mockResolvedValue({ id: "ds_new" });
    await POST(jsonReq({ name: "support" }), params);
    expect(prismaMock.dataset.create.mock.calls[0][0].data.description).toBeNull();
  });

  it("409s a name that already exists in the project (case-insensitive), without creating", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue({ name: "Support" }); // existing, different case
    const res = await POST(jsonReq({ name: "support" }), params);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toContain("already exists");
    expect(prismaMock.dataset.create).not.toHaveBeenCalled();
    // The uniqueness check is scoped to the project and case-insensitive.
    expect(prismaMock.dataset.findFirst).toHaveBeenCalledWith({
      where: { projectId: "p1", name: { equals: "support", mode: "insensitive" } },
      select: { name: true },
    });
  });

  it("409s when a concurrent create wins the race (P2002 from the partial unique index)", async () => {
    // The pre-check clears (findFirst → null), but the create loses to the DB index —
    // the race-safe backstop must surface the same 409, not an unhandled 500.
    prismaMock.dataset.create.mockRejectedValue({ code: "P2002" });
    const res = await POST(jsonReq({ name: "support" }), params);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toContain("already exists");
  });

  it("400s an unparseable body", async () => {
    const res = await POST(badJsonReq(), params);
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: "Invalid JSON" });
  });

  it("400s a body that fails the contract schema", async () => {
    const res = await POST(jsonReq({ description: "no name" }), params);
    expect(res.status).toBe(400);
    expect(prismaMock.dataset.create).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller", async () => {
    auth.requireAuth.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    expect((await POST(jsonReq({ name: "x" }), params)).status).toBe(401);
    expect(prismaMock.dataset.create).not.toHaveBeenCalled();
  });

  it("403s a viewer without write access", async () => {
    auth.requireProjectAccess.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    expect((await POST(jsonReq({ name: "x" }), params)).status).toBe(403);
    expect(prismaMock.dataset.create).not.toHaveBeenCalled();
  });
});
