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
    project: { findUnique: (...args: unknown[]) => projectFindUniqueMock(...args) },
    workspaceMember: { findUnique: (...args: unknown[]) => memberFindUniqueMock(...args) },
  },
  PlanType: { FREE: "free" },
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
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
});

describe("POST /api/internal/user-project-access", () => {
  it("rejects an unauthorized caller before any lookup", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ userId: "u1", projectId: "p1" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(projectFindUniqueMock).not.toHaveBeenCalled();
  });

  it("returns 400 when userId or projectId is missing", async () => {
    const res = await POST(makeRequest({ userId: "u1" }));
    expect(res.status).toBe(400);
    expect(projectFindUniqueMock).not.toHaveBeenCalled();
  });

  it("resolves role/workspace/plan for a member", async () => {
    projectFindUniqueMock.mockResolvedValue({
      id: "proj-123",
      workspaceId: "ws-456",
      workspace: { billingPlan: "pro" },
    });
    memberFindUniqueMock.mockResolvedValue({ role: "admin" });

    const res = await POST(makeRequest({ userId: "user-1", projectId: "proj-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      valid: true,
      hasAccess: true,
      userId: "user-1",
      role: "admin",
      workspaceId: "ws-456",
      billingPlan: "pro",
      projectId: "proj-123",
    });
    // keyed on the passed userId, not a session
    const memberArgs = memberFindUniqueMock.mock.calls[0][0];
    expect(memberArgs.where.workspaceId_userId).toEqual({
      workspaceId: "ws-456",
      userId: "user-1",
    });
  });

  it("falls back to the FREE plan when the workspace has no billingPlan", async () => {
    projectFindUniqueMock.mockResolvedValue({
      id: "proj-123",
      workspaceId: "ws-456",
      workspace: { billingPlan: null },
    });
    memberFindUniqueMock.mockResolvedValue({ role: "viewer" });

    const res = await POST(makeRequest({ userId: "user-1", projectId: "proj-123" }));
    const body = await res.json();

    expect(body.billingPlan).toBe("free");
  });

  it("returns 403 hasAccess:false when the project is not found", async () => {
    projectFindUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ userId: "user-1", projectId: "missing" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ hasAccess: false });
    expect(memberFindUniqueMock).not.toHaveBeenCalled();
  });

  it("returns 403 hasAccess:false when the user is not a member", async () => {
    projectFindUniqueMock.mockResolvedValue({
      id: "proj-123",
      workspaceId: "ws-456",
      workspace: { billingPlan: "pro" },
    });
    memberFindUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ userId: "user-1", projectId: "proj-123" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ hasAccess: false });
  });
});
