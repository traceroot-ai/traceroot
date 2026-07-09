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

describe("POST /api/internal/validate-project-access", () => {
  it("returns access + the workspace billingPlan when the user is a member", async () => {
    projectFindUniqueMock.mockResolvedValue({
      id: "proj-123",
      workspaceId: "ws-456",
      workspace: { billingPlan: "pro" },
    });
    memberFindUniqueMock.mockResolvedValue({ role: "admin" });

    const res = await POST(makeRequest({ userId: "user-1", projectId: "proj-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      hasAccess: true,
      role: "admin",
      workspaceId: "ws-456",
      billingPlan: "pro",
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

  it("rejects an unauthorized caller before touching the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ userId: "user-1", projectId: "proj-123" }));

    expect(res.status).toBe(401);
    expect(projectFindUniqueMock).not.toHaveBeenCalled();
  });

  it("returns hasAccess:false when the project does not exist", async () => {
    projectFindUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ userId: "user-1", projectId: "missing" }));
    const body = await res.json();

    expect(body.hasAccess).toBe(false);
    expect(body.error).toMatch(/not found/i);
  });

  it("returns hasAccess:false when the user is not a workspace member", async () => {
    projectFindUniqueMock.mockResolvedValue({
      id: "proj-123",
      workspaceId: "ws-456",
      workspace: { billingPlan: "pro" },
    });
    memberFindUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ userId: "user-1", projectId: "proj-123" }));
    const body = await res.json();

    expect(body.hasAccess).toBe(false);
    expect(body.error).toMatch(/no access/i);
  });
});
