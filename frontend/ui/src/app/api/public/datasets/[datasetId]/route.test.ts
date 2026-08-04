/**
 * Public dataset read + metadata update (A3), the surface the SDK pins against.
 * Everything is snake_case on the wire, the project comes from the API key (never the
 * body), and a metadata PATCH distinguishes "absent" (leave alone) from an explicit
 * null (clear the JsonB column). Published versions are never touched here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  // The path param may be the SDK-chosen `client_dataset_id` or the internal id, so
  // the route tries the compound-unique lookup first and falls back to findFirst.
  dataset: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
}));
const apiAuth = vi.hoisted(() => ({ requireApiKeyProject: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
  NextRequest: class {},
}));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return { ...actual, prisma: prismaMock };
});
vi.mock("@/lib/eval/auth", () => ({ requireApiKeyProject: apiAuth.requireApiKeyProject }));

import { Prisma } from "@traceroot/core";
import { GET, PATCH } from "./route";

const params = { params: Promise.resolve({ datasetId: "ds1" }) };

const getReq = () => ({}) as unknown as Request;
const jsonReq = (body: unknown) => ({ json: async () => body }) as unknown as Request;
const badJsonReq = () =>
  ({
    json: async () => {
      throw new Error("bad json");
    },
  }) as unknown as Request;

const stored = {
  id: "ds1",
  name: "support",
  description: "tickets",
  currentVersionId: "dv2",
};

async function body(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Record<string, unknown>;
}
const patchData = () => prismaMock.dataset.update.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  apiAuth.requireApiKeyProject.mockResolvedValue({ projectId: "p1" });
  prismaMock.dataset.update.mockResolvedValue(stored);
  // Default: the path param is not a client_dataset_id, so the lookup falls through
  // to the internal-id findFirst that these cases stub.
  prismaMock.dataset.findUnique.mockResolvedValue(null);
});

describe("GET", () => {
  it("returns the dataset in snake_case with the version to pin", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(stored);

    const res = await GET(getReq(), params);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      dataset_id: "ds1",
      name: "support",
      description: "tickets",
      current_dataset_version_id: "dv2",
    });
    // The project comes from the key, so another project's id reads as not found.
    expect(prismaMock.dataset.findFirst.mock.calls[0][0].where).toEqual({
      id: "ds1",
      projectId: "p1",
    });
  });

  it("resolves the path param as the SDK's client_dataset_id before the internal id", async () => {
    // The SDK pins by the id it chose, so that lookup wins and the internal-id
    // fallback is never reached — otherwise a client id equal to some other
    // dataset's internal id would read the wrong row.
    prismaMock.dataset.findUnique.mockResolvedValue(stored);

    expect((await body(await GET(getReq(), params))).dataset_id).toBe("ds1");
    expect(prismaMock.dataset.findUnique.mock.calls[0][0].where).toEqual({
      projectId_clientDatasetId: { projectId: "p1", clientDatasetId: "ds1" },
    });
    expect(prismaMock.dataset.findFirst).not.toHaveBeenCalled();
  });

  it("reports a null version for a dataset with nothing published yet", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue({ ...stored, currentVersionId: null });
    expect((await body(await GET(getReq(), params))).current_dataset_version_id).toBeNull();
  });

  it("404s a dataset the key's project cannot see", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(null);
    const res = await GET(getReq(), params);
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: "Dataset not found" });
  });

  it("401s a request with a bad API key before touching the database", async () => {
    apiAuth.requireApiKeyProject.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Invalid API key" }) },
    });
    const res = await GET(getReq(), params);
    expect(res.status).toBe(401);
    expect(prismaMock.dataset.findFirst).not.toHaveBeenCalled();
  });
});

describe("PATCH", () => {
  it("updates only the fields present and echoes the dataset back", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1" });
    prismaMock.dataset.update.mockResolvedValue({ ...stored, name: "renamed" });

    const res = await PATCH(jsonReq({ name: "renamed" }), params);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ dataset_id: "ds1", name: "renamed" });
    expect(patchData()).toEqual({ name: "renamed" }); // description/metadata untouched
  });

  it("replaces metadata with an object and clears it with an explicit null", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1" });

    await PATCH(jsonReq({ metadata: { owner: "hao" } }), params);
    expect(patchData().metadata).toEqual({ owner: "hao" });

    prismaMock.dataset.update.mockClear();
    await PATCH(jsonReq({ metadata: null, description: null }), params);
    expect(patchData().metadata).toBe(Prisma.DbNull);
    expect(patchData().description).toBeNull();
  });

  it("400s an unparseable body", async () => {
    const res = await PATCH(badJsonReq(), params);
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: "Invalid JSON" });
  });

  it("400s a body that fails the public schema", async () => {
    const res = await PATCH(jsonReq({ name: "" }), params);
    expect(res.status).toBe(400);
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
  });

  it("400s an unknown field rather than silently ignoring it", async () => {
    const res = await PATCH(jsonReq({ current_dataset_version_id: "dv1" }), params);
    expect(res.status).toBe(400);
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
  });

  it("404s a dataset the key's project cannot see, without updating", async () => {
    prismaMock.dataset.findFirst.mockResolvedValue(null);
    const res = await PATCH(jsonReq({ name: "renamed" }), params);
    expect(res.status).toBe(404);
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
  });

  it("401s a request with a bad API key before touching the database", async () => {
    apiAuth.requireApiKeyProject.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Invalid API key" }) },
    });
    const res = await PATCH(jsonReq({ name: "renamed" }), params);
    expect(res.status).toBe(401);
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
  });
});
