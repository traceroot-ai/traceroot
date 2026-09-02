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

const workspaceCreateMock = vi.fn();
const memberCreateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        workspace: { create: (...args: unknown[]) => workspaceCreateMock(...args) },
        workspaceMember: { create: (...args: unknown[]) => memberCreateMock(...args) },
      }),
  },
}));

const requireAuthMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
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

beforeEach(() => {
  workspaceCreateMock.mockReset();
  memberCreateMock.mockReset();
  memberCreateMock.mockResolvedValue({});
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
});

describe("POST /api/workspaces", () => {
  it("creates the workspace with the creator stamped, plus the ADMIN membership", async () => {
    workspaceCreateMock.mockResolvedValue({ id: "ws-1", name: "Acme", createTime: new Date() });
    const res = (await POST(makeRequest({ name: "Acme" }))) as unknown as MockResponse;
    expect(res.status).toBe(201);
    expect(workspaceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Acme", createdBy: "user-1" }),
    });
    expect(memberCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user-1", role: "ADMIN" }),
    });
  });

  it("maps a name collision (Prisma P2002) to 409 instead of 500", async () => {
    workspaceCreateMock.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = (await POST(makeRequest({ name: "Acme" }))) as unknown as MockResponse;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "A workspace with this name already exists",
    );
  });

  it("propagates non-P2002 create failures", async () => {
    workspaceCreateMock.mockRejectedValue(new Error("connection lost"));
    await expect(POST(makeRequest({ name: "Acme" }))).rejects.toThrow("connection lost");
  });
});
