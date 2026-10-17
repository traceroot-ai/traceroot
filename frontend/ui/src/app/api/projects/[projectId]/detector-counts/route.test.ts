import { describe, it, expect, vi, beforeEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const workspaceFindUniqueMock = vi.fn();
const agentRunCountsMock = vi.fn();
vi.mock("@traceroot/core/signals", () => ({
  agentRunCountsByDetector: (...args: unknown[]) => agentRunCountsMock(...args),
}));
vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findUnique: (...args: unknown[]) => workspaceFindUniqueMock(...args),
    },
  },
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
  getRetentionDays: (plan: string) => {
    const days: Record<string, number | null> = {
      free: 15,
      starter: 30,
      pro: 90,
      enterprise: null,
    };
    return Object.prototype.hasOwnProperty.call(days, plan) ? days[plan] : 15;
  },
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
  agentRunCountsMock.mockReset();
  agentRunCountsMock.mockResolvedValue({});
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

  it("returns 400 when start_after is missing and plan is enterprise (no cutoff fallback)", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "enterprise" });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(400);
  });
});

describe("GET .../detector-counts — retention clamp", () => {
  it("clamps start_after to retention cutoff when outside the free plan window", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: {} }));
    const res = await GET(makeRequest({ start_after: old }), makeParams());
    expect(res.status).toBe(200);
    expect(backendFetchMock).toHaveBeenCalled();
    const url = backendFetchMock.mock.calls[0][0] as string;
    const proxiedStart = new URLSearchParams(url.split("?")[1]).get("start_after")!;
    const cutoffMs = Date.now() - 15 * 86_400_000 - 3_600_000;
    expect(Math.abs(new Date(proxiedStart).getTime() - cutoffMs)).toBeLessThan(5000);
  });

  it("passes through when start_after is within the retention window", async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: {} }));
    const res = await GET(makeRequest({ start_after: recent }), makeParams());
    expect(res.status).toBe(200);
    expect(backendFetchMock).toHaveBeenCalled();
    const url = backendFetchMock.mock.calls[0][0] as string;
    const proxiedStart = new URLSearchParams(url.split("?")[1]).get("start_after")!;
    expect(proxiedStart).toBe(recent);
  });

  it("allows wider window for enterprise plans", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "enterprise" });
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: {} }));
    const res = await GET(makeRequest({ start_after: old }), makeParams());
    expect(res.status).toBe(200);
    const url = backendFetchMock.mock.calls[0][0] as string;
    const proxiedStart = new URLSearchParams(url.split("?")[1]).get("start_after")!;
    expect(proxiedStart).toBe(old);
  });

  it("clamps to free plan cutoff when workspace has no billing plan", async () => {
    workspaceFindUniqueMock.mockResolvedValue(null);
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: {} }));
    const res = await GET(makeRequest({ start_after: old }), makeParams());
    expect(res.status).toBe(200);
    const url = backendFetchMock.mock.calls[0][0] as string;
    const proxiedStart = new URLSearchParams(url.split("?")[1]).get("start_after")!;
    const cutoffMs = Date.now() - 15 * 86_400_000 - 3_600_000;
    expect(Math.abs(new Date(proxiedStart).getTime() - cutoffMs)).toBeLessThan(5000);
  });
});

describe("GET .../detector-counts — proxy", () => {
  it("returns 502 when backend is unreachable", async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    backendFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET(makeRequest({ start_after: recent }), makeParams());
    expect(res.status).toBe(502);
  });

  it("adds actual agent-run counts without changing judge counts", async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const body = { data: { "det-1": { finding_count: 3, run_count: 5 } } };
    agentRunCountsMock.mockResolvedValue({ "det-1": 2, "det-2": 1 });
    backendFetchMock.mockResolvedValue(backendResponse(body));
    const res = await GET(makeRequest({ start_after: recent }), makeParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        "det-1": { finding_count: 3, run_count: 5, agent_run_count: 2 },
        "det-2": { finding_count: 0, run_count: 0, agent_run_count: 1 },
      },
    });
    expect(agentRunCountsMock).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      from: new Date(recent),
      to: expect.any(Date),
    });
  });

  it("keeps backend errors and does not query agent counts", async () => {
    const body = { detail: "unavailable" };
    backendFetchMock.mockResolvedValue(backendResponse(body, 503));
    const res = await GET(makeRequest({ start_after: new Date().toISOString() }), makeParams());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(body);
    expect(agentRunCountsMock).not.toHaveBeenCalled();
  });

  it("fails rather than returning a false zero when agent counts are unavailable", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: {} }));
    agentRunCountsMock.mockRejectedValue(new Error("db unavailable"));
    const res = await GET(makeRequest({ start_after: new Date().toISOString() }), makeParams());
    expect(res.status).toBe(500);
  });

  it("passes exclusive range bounds into the agent count", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: {} }));
    const start = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const end = new Date(Date.now() - 86_400_000).toISOString();
    await GET(makeRequest({ start_after: start, end_before: end }), makeParams());
    expect(agentRunCountsMock).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj-1",
      from: new Date(start),
      to: new Date(end),
    });
  });

  it("rejects invalid end times and reversed windows before querying", async () => {
    const start = new Date().toISOString();
    for (const end of ["invalid", new Date(Date.now() - 86_400_000).toISOString()]) {
      expect(
        (await GET(makeRequest({ start_after: start, end_before: end }), makeParams())).status,
      ).toBe(400);
    }
    expect(agentRunCountsMock).not.toHaveBeenCalled();
    expect(backendFetchMock).not.toHaveBeenCalled();
  });
});
