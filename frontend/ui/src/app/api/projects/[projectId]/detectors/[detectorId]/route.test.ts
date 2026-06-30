import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorFindFirstMock = vi.fn();
const detectorUpdateMock = vi.fn();
const detectorDeleteMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    detector: {
      findFirst: (...args: unknown[]) => detectorFindFirstMock(...args),
      update: (...args: unknown[]) => detectorUpdateMock(...args),
      delete: (...args: unknown[]) => detectorDeleteMock(...args),
    },
  },
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { GET, PATCH, DELETE } from "./route";

function makeRequest(body: unknown = {}) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", detectorId: "det-1" }) };
}

beforeEach(() => {
  detectorFindFirstMock.mockReset();
  detectorUpdateMock.mockReset();
  detectorDeleteMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
  detectorFindFirstMock.mockResolvedValue({ id: "det-1", projectId: "proj-1" });
  detectorUpdateMock.mockResolvedValue({ id: "det-1", enabled: false });
  detectorDeleteMock.mockResolvedValue({ id: "det-1" });
});

describe("GET .../detectors/[detectorId] — access", () => {
  it("allows detector reads with project access only", async () => {
    const res = await GET(makeRequest(), makeParams());

    expect(res.status).toBe(200);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1");
  });
});

describe("PATCH .../detectors/[detectorId] — access", () => {
  it("requires MEMBER access to update detectors", async () => {
    const res = await PATCH(makeRequest({ enabled: false }), makeParams());

    expect(res.status).toBe(200);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "MEMBER");
    expect(detectorUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("does not update a detector when MEMBER access is denied", async () => {
    requireProjectAccessMock.mockResolvedValueOnce({
      error: { status: 403, json: async () => ({ error: "Requires MEMBER role or higher" }) },
    });
    const jsonMock = vi.fn().mockResolvedValue({ enabled: false });

    const res = await PATCH(
      { json: jsonMock } as unknown as Parameters<typeof PATCH>[0],
      makeParams(),
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Requires MEMBER role or higher" });
    expect(jsonMock).not.toHaveBeenCalled();
    expect(detectorFindFirstMock).not.toHaveBeenCalled();
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });
});

describe("DELETE .../detectors/[detectorId] — access", () => {
  it("requires ADMIN access to delete detectors", async () => {
    const res = await DELETE(makeRequest(), makeParams());

    expect(res.status).toBe(200);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "ADMIN");
    expect(detectorDeleteMock).toHaveBeenCalledTimes(1);
  });

  it("does not delete a detector when ADMIN access is denied", async () => {
    requireProjectAccessMock.mockResolvedValueOnce({
      error: { status: 403, json: async () => ({ error: "Requires ADMIN role or higher" }) },
    });

    const res = await DELETE(makeRequest(), makeParams());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Requires ADMIN role or higher" });
    expect(detectorFindFirstMock).not.toHaveBeenCalled();
    expect(detectorDeleteMock).not.toHaveBeenCalled();
  });
});
