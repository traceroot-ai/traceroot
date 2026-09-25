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
vi.mock("@traceroot/core", () => ({
  prisma: {
    project: {
      findUnique: (...args: unknown[]) => projectFindUniqueMock(...args),
    },
    workspaceMember: {
      findUnique: (...args: unknown[]) => memberFindUniqueMock(...args),
    },
  },
  PlanType: { FREE: "free" },
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
  projectFindUniqueMock.mockReset();
  memberFindUniqueMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
  resolveTokenMock.mockReset();
});

describe("POST /api/internal/validate-user-token", () => {
  it("rejects an unauthorized caller before touching auth or the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ token: "tok" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ valid: false, error: "Unauthorized" });
    expect(resolveTokenMock).not.toHaveBeenCalled();
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
    expect(body.valid).toBe(false);
  });

  it("returns 400 when token is missing", async () => {
    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.valid).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("returns 401 when the token resolves to no live session", async () => {
    resolveTokenMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ token: "tok" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ valid: false, error: "invalid or expired token" });
  });

  it("propagates a resolver/database error instead of masking it as a bad token", async () => {
    // A DB outage must surface as a 500 (which the backend maps to a fail-closed
    // 503), not a misleading 401 that reads as "your token is invalid".
    resolveTokenMock.mockRejectedValue(new Error("db down"));

    await expect(POST(makeRequest({ token: "tok" }))).rejects.toThrow("db down");
  });

  it("account-scope: no projectId returns valid + userId + email", async () => {
    resolveTokenMock.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
    });

    const res = await POST(makeRequest({ token: "tok" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ valid: true, userId: "user-1", email: "user@example.com" });
    expect(projectFindUniqueMock).not.toHaveBeenCalled();
  });

  it("project-scope: member returns valid + role/workspaceId/billingPlan/projectId", async () => {
    resolveTokenMock.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
    projectFindUniqueMock.mockResolvedValue({
      id: "proj-123",
      workspaceId: "ws-456",
      workspace: { billingPlan: "pro" },
    });
    memberFindUniqueMock.mockResolvedValue({ role: "admin" });

    const res = await POST(makeRequest({ token: "tok", projectId: "proj-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      valid: true,
      userId: "user-1",
      role: "admin",
      workspaceId: "ws-456",
      billingPlan: "pro",
      projectId: "proj-123",
    });
  });

  it("project-scope: falls back to the FREE plan when the workspace has no billingPlan", async () => {
    resolveTokenMock.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
    projectFindUniqueMock.mockResolvedValue({
      id: "proj-123",
      workspaceId: "ws-456",
      workspace: { billingPlan: null },
    });
    memberFindUniqueMock.mockResolvedValue({ role: "viewer" });

    const res = await POST(makeRequest({ token: "tok", projectId: "proj-123" }));
    const body = await res.json();

    expect(body.billingPlan).toBe("free");
  });

  it("project-scope: project not found returns valid:true, hasAccess:false at 403", async () => {
    resolveTokenMock.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
    projectFindUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ token: "tok", projectId: "missing" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ valid: true, hasAccess: false });
    expect(memberFindUniqueMock).not.toHaveBeenCalled();
  });

  it("project-scope: not a member returns valid:true, hasAccess:false at 403", async () => {
    resolveTokenMock.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
    projectFindUniqueMock.mockResolvedValue({
      id: "proj-123",
      workspaceId: "ws-456",
      workspace: { billingPlan: "pro" },
    });
    memberFindUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ token: "tok", projectId: "proj-123" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ valid: true, hasAccess: false });
  });
});
