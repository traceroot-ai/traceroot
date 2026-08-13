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

const memberFindManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    workspaceMember: {
      findMany: (...args: unknown[]) => memberFindManyMock(...args),
    },
  },
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

const resolveTokenMock = vi.fn();
vi.mock("@/lib/internal-session", () => ({
  resolveSessionFromToken: (...args: unknown[]) => resolveTokenMock(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  memberFindManyMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
  resolveTokenMock.mockReset();
});

describe("POST /api/internal/user-memberships", () => {
  it("rejects an unauthorized caller before touching auth or the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ token: "tok" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(resolveTokenMock).not.toHaveBeenCalled();
    expect(memberFindManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const badRequest = {
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(badRequest);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when token is missing", async () => {
    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(typeof body.error).toBe("string");
  });

  it("returns 401 when the token resolves to no live session", async () => {
    resolveTokenMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ token: "tok" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "invalid or expired token" });
    expect(memberFindManyMock).not.toHaveBeenCalled();
  });

  it("propagates a resolver/database error instead of masking it as a bad token", async () => {
    resolveTokenMock.mockRejectedValue(new Error("db down"));

    await expect(POST(makeRequest({ token: "tok" }))).rejects.toThrow("db down");
  });

  it("returns the workspace/project graph for a live session", async () => {
    resolveTokenMock.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
    memberFindManyMock.mockResolvedValue([
      {
        role: "admin",
        workspace: {
          id: "ws-1",
          name: "Alpha",
          projects: [
            { id: "proj-1", name: "P1" },
            { id: "proj-2", name: "P2" },
          ],
        },
      },
      {
        role: "viewer",
        workspace: { id: "ws-2", name: "Beta", projects: [] },
      },
    ]);

    const res = await POST(makeRequest({ token: "tok" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      workspaces: [
        {
          id: "ws-1",
          name: "Alpha",
          role: "admin",
          projects: [
            { id: "proj-1", name: "P1" },
            { id: "proj-2", name: "P2" },
          ],
        },
        { id: "ws-2", name: "Beta", role: "viewer", projects: [] },
      ],
    });
    // scoped to the session user and ordered by workspace name
    const args = memberFindManyMock.mock.calls[0][0];
    expect(args.where).toEqual({ userId: "user-1" });
    expect(args.orderBy).toEqual({ workspace: { name: "asc" } });
  });

  it("returns an empty list when the user has no memberships", async () => {
    resolveTokenMock.mockResolvedValue({ user: { id: "user-1" } });
    memberFindManyMock.mockResolvedValue([]);

    const res = await POST(makeRequest({ token: "tok" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ workspaces: [] });
  });
});
