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

const projectFindUniqueMock = vi.fn();
const memberFindUniqueMock = vi.fn();
const keyFindFirstMock = vi.fn();
const keyCreateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    project: { findUnique: (...args: unknown[]) => projectFindUniqueMock(...args) },
    workspaceMember: { findUnique: (...args: unknown[]) => memberFindUniqueMock(...args) },
    accessKey: {
      findFirst: (...args: unknown[]) => keyFindFirstMock(...args),
      create: (...args: unknown[]) => keyCreateMock(...args),
    },
  },
  Role: { VIEWER: "viewer", MEMBER: "member", ADMIN: "admin" },
}));

vi.mock("@/lib/api-keys", () => ({
  generateApiKey: () => "tr-generated-secret",
  getKeyPrefix: (s: string) => s.slice(0, 7),
  hashApiKey: (s: string) => `hash:${s}`,
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const VALID = { userId: "u1", projectId: "proj-1", name: "laptop" };

beforeEach(() => {
  projectFindUniqueMock.mockReset();
  memberFindUniqueMock.mockReset();
  keyFindFirstMock.mockReset();
  keyCreateMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
  projectFindUniqueMock.mockResolvedValue({ id: "proj-1", name: "checkout", workspaceId: "ws-1" });
  memberFindUniqueMock.mockResolvedValue({ role: "member" });
  keyFindFirstMock.mockResolvedValue(null);
  keyCreateMock.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "key-1",
    keyHint: args.data.keyHint,
    name: args.data.name,
    projectId: args.data.projectId,
    scope: args.data.scope,
    expireTime: args.data.expireTime,
    createTime: new Date("2026-08-18T00:00:00.000Z"),
  }));
});

describe("POST /api/internal/user-create-project-key", () => {
  it("rejects an unauthorized caller before any lookup", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(401);
    // "before any lookup" is the claim: an unauthenticated caller must not reach
    // the database at all, so the project and membership reads are what this
    // asserts on. Checking only the create would still pass if the secret check
    // moved below them.
    expect(projectFindUniqueMock).not.toHaveBeenCalled();
    expect(memberFindUniqueMock).not.toHaveBeenCalled();
    expect(keyCreateMock).not.toHaveBeenCalled();
  });

  it("mints a key and returns the secret exactly once", async () => {
    const res = await POST(makeRequest({ ...VALID, scope: "admin" }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.key).toBe("tr-generated-secret");
    expect(body.hint).toBe("tr-gene");
    expect(body.scope).toBe("admin");
    // Only the hash is persisted; the secret never is.
    expect(keyCreateMock.mock.calls[0][0].data.secretHash).toBe("hash:tr-generated-secret");
    expect(keyCreateMock.mock.calls[0][0].data).not.toHaveProperty("secret");
  });

  it("defaults to the ingest scope when none is asked for", async () => {
    const res = await POST(makeRequest(VALID));

    expect((await res.json()).scope).toBe("ingest");
  });

  it("returns 404 for a project that does not exist or is deleted", async () => {
    projectFindUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(404);
    expect(keyCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a viewer, matching the browser route's threshold", async () => {
    memberFindUniqueMock.mockResolvedValue({ role: "viewer" });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(403);
    expect(keyCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a non-member of the project's workspace", async () => {
    memberFindUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(403);
    expect(keyCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a duplicate key name in the same project", async () => {
    keyFindFirstMock.mockResolvedValue({ id: "existing" });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(409);
    expect(keyCreateMock).not.toHaveBeenCalled();
  });

  it("turns an expiry in days into a concrete timestamp", async () => {
    await POST(makeRequest({ ...VALID, expiresInDays: 7 }));

    const expireTime = keyCreateMock.mock.calls[0][0].data.expireTime as Date;
    const days = (expireTime.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("leaves a key non-expiring when no expiry is asked for", async () => {
    await POST(makeRequest(VALID));

    expect(keyCreateMock.mock.calls[0][0].data.expireTime).toBeNull();
  });

  it("rejects an unknown scope", async () => {
    const res = await POST(makeRequest({ ...VALID, scope: "root" }));

    expect(res.status).toBe(400);
    expect(keyCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body", async () => {
    const res = await POST({
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Parameters<typeof POST>[0]);

    expect(res.status).toBe(400);
  });
});
