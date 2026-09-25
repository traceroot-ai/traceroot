/**
 * Public dataset list (A1) + upsert (A2). The upsert is idempotent within the
 * project on the client-chosen `dataset_id`, and carries the dataset `key` (the
 * pre-image of `dataset_id`) on the wire: it is persisted on create, backfilled
 * onto a keyless existing row, and echoed back on every response so a pulled
 * dataset recovers its key when `key != name`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  dataset: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
const apiAuth = vi.hoisted(() => ({ requireApiKeyProject: vi.fn() }));
const prismaErr = vi.hoisted(() => ({ isPrismaKnownError: vi.fn(() => false) }));

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
vi.mock("@/lib/eval/prisma-errors", () => ({
  isPrismaKnownError: prismaErr.isPrismaKnownError,
}));

import { GET, POST } from "./route";

const listReq = () => ({ url: "http://localhost/api/public/datasets" }) as unknown as Request;
const jsonReq = (body: unknown) => ({ json: async () => body }) as unknown as Request;

async function body(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Record<string, unknown>;
}
const createArg = () => prismaMock.dataset.create.mock.calls[0][0];
const updateArg = () => prismaMock.dataset.update.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  apiAuth.requireApiKeyProject.mockResolvedValue({ projectId: "p1" });
  prismaErr.isPrismaKnownError.mockReturnValue(false);
});

describe("GET (list)", () => {
  it("shows the SDK-facing dataset_id and echoes the key, falling back to the row id", async () => {
    prismaMock.dataset.findMany.mockResolvedValue([
      {
        id: "row1",
        clientDatasetId: "ds_abc",
        key: "billing",
        name: "Billing",
        description: null,
        currentVersionId: "dv1",
        updateTime: new Date("2026-08-12T00:00:00Z"),
      },
      // A UI-authored dataset has no client id/key: dataset_id falls back to the row id.
      {
        id: "row2",
        clientDatasetId: null,
        key: null,
        name: "Ad hoc",
        description: null,
        currentVersionId: null,
        updateTime: new Date("2026-08-12T00:00:00Z"),
      },
    ]);

    const res = await GET(listReq());
    const { datasets } = (await body(res)) as { datasets: Array<Record<string, unknown>> };
    expect(datasets[0]).toMatchObject({ dataset_id: "ds_abc", key: "billing" });
    expect(datasets[1]).toMatchObject({ dataset_id: "row2", key: null });
  });
});

describe("POST (upsert)", () => {
  const upsert = { dataset_id: "ds_abc", name: "Billing", key: "billing" };

  it("creates a new dataset, persisting and echoing the key", async () => {
    prismaMock.dataset.findUnique.mockResolvedValue(null);
    prismaMock.dataset.create.mockResolvedValue({
      name: "Billing",
      description: null,
      currentVersionId: null,
      key: "billing",
    });

    const res = await POST(jsonReq(upsert));
    expect(res.status).toBe(201);
    expect(await body(res)).toEqual({
      dataset_id: "ds_abc",
      name: "Billing",
      description: null,
      current_dataset_version_id: null,
      key: "billing",
    });
    expect(createArg().data.key).toBe("billing");
  });

  it("stores a null key when the caller omits it (older SDK)", async () => {
    prismaMock.dataset.findUnique.mockResolvedValue(null);
    prismaMock.dataset.create.mockResolvedValue({
      name: "Billing",
      description: null,
      currentVersionId: null,
      key: null,
    });

    const res = await POST(jsonReq({ dataset_id: "ds_abc", name: "Billing" }));
    expect(res.status).toBe(201);
    expect(createArg().data.key).toBeNull();
    expect((await body(res)).key).toBeNull();
  });

  it("returns an existing dataset without clobbering its stored key", async () => {
    prismaMock.dataset.findUnique.mockResolvedValue({
      name: "Billing",
      description: "x",
      currentVersionId: "dv3",
      key: "billing",
    });

    const res = await POST(jsonReq({ ...upsert, key: "something-else" }));
    expect(res.status).toBe(200);
    expect((await body(res)).key).toBe("billing");
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
    expect(prismaMock.dataset.create).not.toHaveBeenCalled();
  });

  it("backfills the key onto a keyless existing dataset", async () => {
    prismaMock.dataset.findUnique.mockResolvedValue({
      name: "Billing",
      description: null,
      currentVersionId: "dv3",
      key: null,
    });
    prismaMock.dataset.update.mockResolvedValue({
      name: "Billing",
      description: null,
      currentVersionId: "dv3",
      key: "billing",
    });

    const res = await POST(jsonReq(upsert));
    expect(res.status).toBe(200);
    expect(updateArg().data).toEqual({ key: "billing" });
    expect((await body(res)).key).toBe("billing");
  });

  it("does not write when a keyless dataset exists and the caller omits the key", async () => {
    prismaMock.dataset.findUnique.mockResolvedValue({
      name: "Billing",
      description: null,
      currentVersionId: "dv3",
      key: null,
    });

    const res = await POST(jsonReq({ dataset_id: "ds_abc", name: "Billing" }));
    expect(res.status).toBe(200);
    expect(prismaMock.dataset.update).not.toHaveBeenCalled();
    expect((await body(res)).key).toBeNull();
  });

  it("answers a raced first-time create as the idempotent 200", async () => {
    prismaMock.dataset.findUnique
      .mockResolvedValueOnce(null) // pre-check: not there yet
      .mockResolvedValueOnce({
        name: "Billing",
        description: null,
        currentVersionId: null,
        key: "billing",
      }); // re-read after the unique violation
    prismaMock.dataset.create.mockRejectedValue(new Error("unique"));
    prismaErr.isPrismaKnownError.mockReturnValue(true);

    const res = await POST(jsonReq(upsert));
    expect(res.status).toBe(200);
    expect((await body(res)).key).toBe("billing");
  });

  it("400s an unknown field rather than silently accepting it", async () => {
    const res = await POST(jsonReq({ dataset_id: "ds_abc", name: "Billing", bogus: 1 }));
    expect(res.status).toBe(400);
    expect(prismaMock.dataset.create).not.toHaveBeenCalled();
  });

  it("401s a bad API key before touching the database", async () => {
    apiAuth.requireApiKeyProject.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Invalid API key" }) },
    });
    const res = await POST(jsonReq(upsert));
    expect(res.status).toBe(401);
    expect(prismaMock.dataset.findUnique).not.toHaveBeenCalled();
  });
});
