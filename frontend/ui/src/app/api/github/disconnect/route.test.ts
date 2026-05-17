import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data, init) => ({
      status: init?.status ?? 200,
      json: async () => data,
      cookies: { set: vi.fn() },
    })),
  },
}));

const deleteManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    gitHubInstallation: {
      deleteMany: (...args: unknown[]) => deleteManyMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireMembershipMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
}));

import { POST } from "./route";

function makeRequest(workspaceId: string | null, installationId: string | null = null) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspaceId", workspaceId);
  if (installationId) params.set("installationId", installationId);
  return {
    nextUrl: { searchParams: params },
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  deleteManyMock.mockReset();
  requireAuthMock.mockReset();
  requireMembershipMock.mockReset();
});

describe("POST /api/github/disconnect", () => {
  it("returns 401 when not authenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = await POST(makeRequest("ws_1"));
    expect(res.status).toBe(401);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 when workspaceId is missing", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(400);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 403 for non-ADMIN members", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    requireMembershipMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Requires ADMIN role or higher" }) },
    });
    const res = await POST(makeRequest("ws_1"));
    expect(res.status).toBe(403);
    expect(requireMembershipMock).toHaveBeenCalledWith("u_1", "ws_1", "ADMIN");
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("deletes all installations for the workspace when no installationId", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    requireMembershipMock.mockResolvedValue({ membership: { workspaceId: "ws_1" } });
    deleteManyMock.mockResolvedValue({ count: 2 });
    const res = await POST(makeRequest("ws_1"));
    expect(res.status).toBe(200);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { workspaceId: "ws_1" } });
  });

  it("deletes a single installation when installationId is provided", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    requireMembershipMock.mockResolvedValue({ membership: { workspaceId: "ws_1" } });
    deleteManyMock.mockResolvedValue({ count: 1 });
    const res = await POST(makeRequest("ws_1", "inst_42"));
    expect(res.status).toBe(200);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1", installationId: "inst_42" },
    });
  });

  it("never deletes installs from other workspaces", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    requireMembershipMock.mockResolvedValue({ membership: { workspaceId: "ws_1" } });
    deleteManyMock.mockResolvedValue({ count: 0 });
    await POST(makeRequest("ws_1"));
    const call = deleteManyMock.mock.calls[0][0];
    expect(call.where.workspaceId).toBe("ws_1");
  });
});
