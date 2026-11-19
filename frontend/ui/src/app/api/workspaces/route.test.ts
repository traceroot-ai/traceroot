import { describe, it, expect, vi, beforeEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

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
const memberFindManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  prisma: {
    workspaceMember: { findMany: (...args: unknown[]) => memberFindManyMock(...args) },
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

import { GET, POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  memberFindManyMock.mockReset();
  workspaceCreateMock.mockReset();
  memberCreateMock.mockReset();
  memberCreateMock.mockResolvedValue({});
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
});

describe("GET /api/workspaces with a demo workspace", () => {
  function membership(id: string, name: string, role: string, members: number) {
    return {
      role,
      workspace: { id, name, createTime: "2026-10-01", projects: [], _count: { members } },
    };
  }

  it("lists the demo last, marks it, and hides its member count", async () => {
    vi.stubEnv("DEMO_WORKSPACE_ID", "ws-demo");
    try {
      memberFindManyMock.mockResolvedValue([
        membership("ws-demo", "Acme Demo", "VIEWER", 5000),
        membership("ws-own", "Zeta", "ADMIN", 2),
      ]);

      const res = (await (GET as unknown as () => Promise<MockResponse>)()) as MockResponse;
      const body = (await res.json()) as {
        workspaces: { id: string; is_demo: boolean; member_count?: number }[];
      };

      expect(body.workspaces.map((w) => [w.id, w.is_demo, w.member_count])).toEqual([
        ["ws-own", false, 2],
        ["ws-demo", true, undefined],
      ]);
      // The workspace list shows the demo, so the query includes it.
      expect(memberFindManyMock.mock.calls[0][0].where).toEqual({ userId: "user-1" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
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
