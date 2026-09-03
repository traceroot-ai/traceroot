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

const projectCreateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  prisma: {
    project: { create: (...args: unknown[]) => projectCreateMock(...args) },
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

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function makeParams(workspaceId = "ws-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

beforeEach(() => {
  projectCreateMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockReset();
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "MEMBER" } });
});

describe("POST /api/workspaces/[workspaceId]/projects", () => {
  it("creates the project with 201", async () => {
    projectCreateMock.mockResolvedValue({
      id: "p1",
      name: "Checkout",
      traceTtlDays: null,
      createTime: new Date(),
    });
    const res = (await POST(makeRequest({ name: "Checkout" }), makeParams())) as MockResponse;
    expect(res.status).toBe(201);
    expect(projectCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: "ws-1", name: "Checkout" }),
    });
  });

  it("maps a duplicate live name (Prisma P2002) to 409 instead of 500", async () => {
    projectCreateMock.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = (await POST(makeRequest({ name: "Checkout" }), makeParams())) as MockResponse;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "A project with this name already exists",
    );
  });

  it("propagates non-P2002 create failures", async () => {
    projectCreateMock.mockRejectedValue(new Error("connection lost"));
    await expect(POST(makeRequest({ name: "Checkout" }), makeParams())).rejects.toThrow(
      "connection lost",
    );
  });
});
