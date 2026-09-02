import { describe, it, expect, vi, beforeEach } from "vitest";

type MockResponse = { status: number; json: () => Promise<unknown> };

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const workspaceUpdateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  prisma: {
    workspace: { update: (...args: unknown[]) => workspaceUpdateMock(...args) },
  },
}));

const requireAuthMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { PUT } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PUT>[0];
}

function makeParams(workspaceId = "ws-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

beforeEach(() => {
  workspaceUpdateMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockReset();
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
});

describe("PUT /api/workspaces/[workspaceId]", () => {
  it("renames the workspace", async () => {
    workspaceUpdateMock.mockResolvedValue({
      id: "ws-1",
      name: "Renamed",
      updateTime: new Date(),
    });
    const res = (await PUT(makeRequest({ name: "Renamed" }), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
  });

  it("maps a rename collision (Prisma P2002) to 409 instead of 500", async () => {
    workspaceUpdateMock.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = (await PUT(makeRequest({ name: "Taken" }), makeParams())) as MockResponse;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "A workspace with this name already exists",
    );
  });

  it("propagates non-P2002 update failures", async () => {
    workspaceUpdateMock.mockRejectedValue(new Error("connection lost"));
    await expect(PUT(makeRequest({ name: "Renamed" }), makeParams())).rejects.toThrow(
      "connection lost",
    );
  });
});
