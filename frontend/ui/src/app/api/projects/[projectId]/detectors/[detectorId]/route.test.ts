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

import { PATCH, DELETE } from "./route";

function makeParams(detectorId = "det-1") {
  return { params: Promise.resolve({ projectId: "proj-1", detectorId }) };
}

function makePatchRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeDeleteRequest() {
  return {} as unknown as Parameters<typeof DELETE>[0];
}

function viewerForbidden() {
  return {
    error: { status: 403, json: async () => ({ error: "Requires MEMBER role or higher" }) },
  };
}

function adminForbidden() {
  return {
    error: { status: 403, json: async () => ({ error: "Requires ADMIN role or higher" }) },
  };
}

beforeEach(() => {
  detectorFindFirstMock.mockReset();
  detectorUpdateMock.mockReset();
  detectorDeleteMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
});

describe("PATCH .../detectors/[detectorId] — role gate", () => {
  it("returns 403 for VIEWER (requires MEMBER)", async () => {
    requireProjectAccessMock.mockResolvedValue(viewerForbidden());
    const res = await PATCH(makePatchRequest({ name: "updated" }), makeParams());
    expect(res.status).toBe(403);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "MEMBER");
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("allows MEMBER to update a detector", async () => {
    requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "ws-1" } });
    detectorFindFirstMock.mockResolvedValue({ id: "det-1", projectId: "proj-1" });
    detectorUpdateMock.mockResolvedValue({ id: "det-1", name: "updated" });
    const res = await PATCH(makePatchRequest({ name: "updated" }), makeParams());
    expect(res.status).toBe(200);
    expect(detectorUpdateMock).toHaveBeenCalled();
  });
});

describe("DELETE .../detectors/[detectorId] — role gate", () => {
  it("returns 403 for VIEWER (requires ADMIN)", async () => {
    requireProjectAccessMock.mockResolvedValue(adminForbidden());
    const res = await DELETE(makeDeleteRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "ADMIN");
    expect(detectorDeleteMock).not.toHaveBeenCalled();
  });

  it("returns 403 for MEMBER (requires ADMIN)", async () => {
    requireProjectAccessMock.mockResolvedValue(adminForbidden());
    const res = await DELETE(makeDeleteRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(detectorDeleteMock).not.toHaveBeenCalled();
  });

  it("allows ADMIN to delete a detector", async () => {
    requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "ws-1" } });
    detectorFindFirstMock.mockResolvedValue({ id: "det-1", projectId: "proj-1" });
    detectorDeleteMock.mockResolvedValue({});
    const res = await DELETE(makeDeleteRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(detectorDeleteMock).toHaveBeenCalledWith({ where: { id: "det-1" } });
  });
});
