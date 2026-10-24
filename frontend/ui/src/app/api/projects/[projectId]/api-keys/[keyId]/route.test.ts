import { describe, it, expect, vi, beforeEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const getRequestSessionMock = vi.fn();
vi.mock("@/lib/request-session", () => ({
  getRequestSession: (...args: unknown[]) => getRequestSessionMock(...args),
}));

// The real auth helpers run against this fake, so the role rule under test is
// the one the route actually applies. `deleteMany` honours its `where`, which is
// what makes the other-project case mean anything.
const KEYS = [
  { id: "key-1", projectId: "proj-1" },
  { id: "key-other", projectId: "proj-2" },
];
const deleteMatching = async ({ where }: { where: { id: string; projectId: string } }) => ({
  count: KEYS.filter((k) => k.id === where.id && k.projectId === where.projectId).length,
});
const memberFindUniqueMock = vi.fn();
const keyDeleteMock = vi.fn();
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  return {
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole),
    prisma: {
      project: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === "proj-1" ? { id: "proj-1", workspaceId: "ws-1", name: "checkout" } : null,
      },
      workspaceMember: { findUnique: (...args: unknown[]) => memberFindUniqueMock(...args) },
      accessKey: {
        deleteMany: (...args: unknown[]) => keyDeleteMock(...args),
      },
    },
  };
});

import { DELETE } from "./route";

type MockResponse = { status: number; json: () => Promise<unknown> };

async function revoke(keyId: string, projectId = "proj-1") {
  return (await DELETE({} as Parameters<typeof DELETE>[0], {
    params: Promise.resolve({ projectId, keyId }),
  })) as unknown as MockResponse;
}

beforeEach(() => {
  getRequestSessionMock.mockReset();
  memberFindUniqueMock.mockReset();
  keyDeleteMock.mockReset();
  getRequestSessionMock.mockResolvedValue({ user: { id: "u1" } });
  memberFindUniqueMock.mockResolvedValue({ workspaceId: "ws-1", userId: "u1", role: "ADMIN" });
  keyDeleteMock.mockImplementation(deleteMatching);
});

describe("DELETE /api/projects/[projectId]/api-keys/[keyId]", () => {
  it("deletes a key in the project for a workspace admin", async () => {
    const res = await revoke("key-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(keyDeleteMock).toHaveBeenCalledWith({ where: { id: "key-1", projectId: "proj-1" } });
  });

  it("answers 404 for a key in another project and leaves it alone", async () => {
    const res = await revoke("key-other");

    expect(res.status).toBe(404);
    // The delete is scoped to this project, so it matched nothing.
    expect(await keyDeleteMock.mock.results[0].value).toEqual({ count: 0 });
  });

  it("refuses a member, since deleting a key is reserved for admins", async () => {
    memberFindUniqueMock.mockResolvedValue({ workspaceId: "ws-1", userId: "u1", role: "MEMBER" });

    const res = await revoke("key-1");

    expect(res.status).toBe(403);
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    getRequestSessionMock.mockResolvedValue(null);

    const res = await revoke("key-1");

    expect(res.status).toBe(401);
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });
});
