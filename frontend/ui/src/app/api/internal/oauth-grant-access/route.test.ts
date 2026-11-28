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

const consentFindFirstMock = vi.fn();
const clientFindUniqueMock = vi.fn();
const projectFindUniqueMock = vi.fn();
const memberFindUniqueMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    oauthConsent: { findFirst: (...args: unknown[]) => consentFindFirstMock(...args) },
    oauthClient: { findUnique: (...args: unknown[]) => clientFindUniqueMock(...args) },
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

const BODY = { userId: "u1", projectId: "p1", clientId: "c1" };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  for (const m of [
    consentFindFirstMock,
    clientFindUniqueMock,
    projectFindUniqueMock,
    memberFindUniqueMock,
    verifyInternalSecretMock,
  ]) {
    m.mockReset();
  }
  verifyInternalSecretMock.mockReturnValue(true);
  consentFindFirstMock.mockResolvedValue({ id: "consent-1" });
  clientFindUniqueMock.mockResolvedValue({ disabled: false });
  projectFindUniqueMock.mockResolvedValue({
    id: "p1",
    workspaceId: "w1",
    workspace: { billingPlan: "pro" },
  });
  memberFindUniqueMock.mockResolvedValue({ role: "MEMBER" });
});

describe("POST /api/internal/oauth-grant-access", () => {
  it("rejects an unauthorized caller before any lookup", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest(BODY));

    expect(res.status).toBe(401);
    expect(consentFindFirstMock).not.toHaveBeenCalled();
  });

  it.each([{ userId: "u1", projectId: "p1" }, { userId: "u1", clientId: "c1" }, {}])(
    "returns 400 when a field is missing (%j)",
    async (body) => {
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      expect(consentFindFirstMock).not.toHaveBeenCalled();
    },
  );

  it("resolves role, workspace and plan for a live grant", async () => {
    const res = await POST(makeRequest(BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: true,
      hasAccess: true,
      userId: "u1",
      role: "MEMBER",
      workspaceId: "w1",
      billingPlan: "pro",
      projectId: "p1",
    });
  });

  it("looks the consent up by user, client AND project", async () => {
    await POST(makeRequest(BODY));

    expect(consentFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", clientId: "c1", referenceId: "p1" } }),
    );
  });

  it("is a 401 once the consent is gone (the connection was revoked)", async () => {
    consentFindFirstMock.mockResolvedValue(null);

    const res = await POST(makeRequest(BODY));

    expect(res.status).toBe(401);
    expect(projectFindUniqueMock).not.toHaveBeenCalled();
  });

  it("is a 401 for a disabled client", async () => {
    clientFindUniqueMock.mockResolvedValue({ disabled: true });
    expect((await POST(makeRequest(BODY))).status).toBe(401);
  });

  it("is a 401 for an unknown client", async () => {
    clientFindUniqueMock.mockResolvedValue(null);
    expect((await POST(makeRequest(BODY))).status).toBe(401);
  });

  it("is a 403 when the project is gone", async () => {
    projectFindUniqueMock.mockResolvedValue(null);
    expect((await POST(makeRequest(BODY))).status).toBe(403);
  });

  it("is a 403 when the user no longer belongs to the project's workspace", async () => {
    memberFindUniqueMock.mockResolvedValue(null);
    expect((await POST(makeRequest(BODY))).status).toBe(403);
  });
});
