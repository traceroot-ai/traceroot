import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/request-session", () => ({ getRequestSession: vi.fn() }));

// The real auth helpers and the real shared revoke run against this fake, so
// the rule under test is the dashboard's own. `findFirst` honours its `where`,
// which is what makes the other-project case mean anything.
const KEYS = [
  { id: "key-1", projectId: "proj-1" },
  { id: "key-other", projectId: "proj-2" },
];
const projectFindUniqueMock = vi.fn();
const memberFindUniqueMock = vi.fn();
const keyDeleteMock = vi.fn();
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  return {
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole),
    prisma: {
      project: { findUnique: (...args: unknown[]) => projectFindUniqueMock(...args) },
      workspaceMember: { findUnique: (...args: unknown[]) => memberFindUniqueMock(...args) },
      accessKey: {
        // An absent filter matches any row, as in Prisma.
        findFirst: async ({ where }: { where: { id: string; projectId?: string } }) =>
          KEYS.find(
            (k) =>
              k.id === where.id &&
              (where.projectId === undefined || k.projectId === where.projectId),
          ) ?? null,
        delete: (...args: unknown[]) => keyDeleteMock(...args),
      },
    },
  };
});

import { POST } from "./route";

type MockResponse = { status: number; json: () => Promise<unknown> };

function makeRequest(body: unknown, secret: string | null = "test-secret") {
  return {
    headers: new Headers(secret === null ? {} : { "X-Internal-Secret": secret }),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

async function revoke(body: unknown, secret?: string | null) {
  return (await POST(makeRequest(body, secret))) as unknown as MockResponse;
}

const VALID = { userId: "u1", projectId: "proj-1", keyId: "key-1" };

beforeEach(() => {
  projectFindUniqueMock.mockReset();
  memberFindUniqueMock.mockReset();
  keyDeleteMock.mockReset();
  projectFindUniqueMock.mockResolvedValue({ id: "proj-1", workspaceId: "ws-1", name: "checkout" });
  memberFindUniqueMock.mockResolvedValue({ workspaceId: "ws-1", userId: "u1", role: "ADMIN" });
  keyDeleteMock.mockResolvedValue({});
});

describe("POST /api/internal/user-revoke-project-key", () => {
  it("revokes a key in the project for a workspace admin", async () => {
    const res = await revoke(VALID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(keyDeleteMock).toHaveBeenCalledWith({ where: { id: "key-1" } });
    // The role is checked for THIS user in THIS project's workspace.
    expect(memberFindUniqueMock.mock.calls[0][0].where).toEqual({
      workspaceId_userId: { workspaceId: "ws-1", userId: "u1" },
    });
  });

  it("answers 404 for a key in another project and never revokes it", async () => {
    const res = await revoke({ ...VALID, keyId: "key-other" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Access key not found" });
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a key that is already gone", async () => {
    const res = await revoke({ ...VALID, keyId: "key-revoked-earlier" });

    expect(res.status).toBe(404);
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a project that does not exist or is deleted", async () => {
    projectFindUniqueMock.mockResolvedValue(null);

    const res = await revoke(VALID);

    expect(res.status).toBe(404);
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });

  it.each(["MEMBER", "VIEWER"])(
    "refuses a %s, since the dashboard reserves revoking a key for admins",
    async (role) => {
      memberFindUniqueMock.mockResolvedValue({ workspaceId: "ws-1", userId: "u1", role });

      const res = await revoke(VALID);

      expect(res.status).toBe(403);
      expect(keyDeleteMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a non-member of the project's workspace", async () => {
    memberFindUniqueMock.mockResolvedValue(null);

    const res = await revoke(VALID);

    expect(res.status).toBe(403);
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no", null],
    ["a wrong", "not-the-secret"],
  ])("rejects a call with %s internal secret before any lookup", async (_label, secret) => {
    const res = await revoke(VALID, secret);

    expect(res.status).toBe(401);
    expect(projectFindUniqueMock).not.toHaveBeenCalled();
    expect(memberFindUniqueMock).not.toHaveBeenCalled();
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });

  it("rejects a body without a key id", async () => {
    const res = await revoke({ userId: "u1", projectId: "proj-1" });

    expect(res.status).toBe(400);
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body", async () => {
    const res = (await POST({
      headers: new Headers({ "X-Internal-Secret": "test-secret" }),
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Parameters<typeof POST>[0])) as unknown as MockResponse;

    expect(res.status).toBe(400);
    expect(keyDeleteMock).not.toHaveBeenCalled();
  });
});
