import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const workspaceFindUniqueMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findUnique: (...args: unknown[]) => workspaceFindUniqueMock(...args),
    },
  },
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => Response.json({ error: msg }, { status }),
}));

import { GET } from "./route";

const backendFetchMock = vi.fn();
vi.stubGlobal("fetch", backendFetchMock);

function makeRequest(query: Record<string, string> = {}) {
  const params = new URLSearchParams(query);
  return { nextUrl: { searchParams: params } } as unknown as Parameters<typeof GET>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1" }) };
}

function backendResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  workspaceFindUniqueMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  backendFetchMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "ws-1" } });
  workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "free" });
});

describe("GET .../detector-counts — auth", () => {
  it("returns the auth error when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await GET(makeRequest({ start_after: new Date().toISOString() }), makeParams());
    expect(res.status).toBe(401);
    expect(backendFetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 when start_after is missing", async () => {
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(400);
  });
});

describe("GET .../detector-counts — retention gate", () => {
  it("returns 403 when start_after is outside the free plan retention window", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const res = await GET(makeRequest({ start_after: old }), makeParams());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { retention_days: number; plan: string } };
    expect(body.detail.retention_days).toBe(15);
    expect(body.detail.plan).toBe("free");
    expect(backendFetchMock).not.toHaveBeenCalled();
  });

  it("passes through when start_after is within the retention window", async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: {} }));
    const res = await GET(makeRequest({ start_after: recent }), makeParams());
    expect(res.status).toBe(200);
    expect(backendFetchMock).toHaveBeenCalled();
  });

  it("allows wider window for enterprise plans", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "enterprise" });
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: {} }));
    const res = await GET(makeRequest({ start_after: old }), makeParams());
    expect(res.status).toBe(200);
  });

  it("defaults to free plan when workspace has no billing plan", async () => {
    workspaceFindUniqueMock.mockResolvedValue(null);
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const res = await GET(makeRequest({ start_after: old }), makeParams());
    expect(res.status).toBe(403);
  });
});

describe("GET .../detector-counts — proxy", () => {
  it("returns 502 when backend is unreachable", async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    backendFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET(makeRequest({ start_after: recent }), makeParams());
    expect(res.status).toBe(502);
  });

  it("forwards the backend response status and body", async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const body = { data: { "det-1": { finding_count: 3, run_count: 5 } } };
    backendFetchMock.mockResolvedValue(backendResponse(body));
    const res = await GET(makeRequest({ start_after: recent }), makeParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
  });
});
