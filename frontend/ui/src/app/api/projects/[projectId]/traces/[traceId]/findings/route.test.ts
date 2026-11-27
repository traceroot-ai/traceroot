import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({ NextRequest: class {} }));

const workspaceFindUniqueMock = vi.fn();
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
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
}));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "secret" } }));

import { GET } from "./route";

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", traceId: "trace-1" }) };
}

beforeEach(() => {
  workspaceFindUniqueMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "ws-1" } });
  workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "free" });

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      findings: [
        {
          finding_id: "find-1",
          detector_id: "det-a",
          trace_id: "trace-1",
          summary: "found",
        },
      ],
    }),
  }) as unknown as typeof fetch;
});

describe("GET .../findings — auth, access & backend proxy", () => {
  it("short-circuits on auth failure before checking project access", async () => {
    const authError = { status: 401 };
    requireAuthMock.mockResolvedValue({ error: authError });

    const res = await GET({} as never, makeParams());

    expect(res).toBe(authError);
    expect(requireProjectAccessMock).not.toHaveBeenCalled();
    expect(workspaceFindUniqueMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns the access error and never queries when project access is denied", async () => {
    const accessError = { status: 403 };
    requireProjectAccessMock.mockResolvedValue({ error: accessError });

    const res = await GET({} as never, makeParams());

    expect(res).toBe(accessError);
    expect(workspaceFindUniqueMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("propagates the backend status when the upstream fetch is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const res = await GET({} as never, makeParams());

    expect(res.status).toBe(500);
  });

  it("returns the proxied findings on success", async () => {
    const res = await GET({} as never, makeParams());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0].finding_id).toBe("find-1");
  });
});

describe("GET .../findings — retention cutoff", () => {
  const FIXED_NOW = new Date("2026-06-24T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the free plan cutoff (now - 15 days - 1 hour) as start_after", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "free" });

    await GET({} as never, makeParams());

    const url = new URL((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const expected = new Date(FIXED_NOW.getTime() - 15 * 86_400_000 - 3_600_000).toISOString();
    expect(url.searchParams.get("project_id")).toBe("proj-1");
    expect(url.searchParams.get("start_after")).toBe(expected);
  });

  it("passes the pro plan cutoff (now - 90 days - 1 hour) as start_after", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "pro" });

    await GET({} as never, makeParams());

    const url = new URL((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const expected = new Date(FIXED_NOW.getTime() - 90 * 86_400_000 - 3_600_000).toISOString();
    expect(url.searchParams.get("project_id")).toBe("proj-1");
    expect(url.searchParams.get("start_after")).toBe(expected);
  });

  it("omits start_after for enterprise plans", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "enterprise" });

    await GET({} as never, makeParams());

    const url = new URL((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(url.searchParams.get("project_id")).toBe("proj-1");
    expect(url.searchParams.has("start_after")).toBe(false);
    expect(url.search).toBe("?project_id=proj-1");
  });

  it("fails closed to the free cutoff when the workspace is not found", async () => {
    workspaceFindUniqueMock.mockResolvedValue(null);

    await GET({} as never, makeParams());

    const url = new URL((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const expected = new Date(FIXED_NOW.getTime() - 15 * 86_400_000 - 3_600_000).toISOString();
    expect(url.searchParams.get("start_after")).toBe(expected);
  });

  it("looks up the workspace using the project's workspaceId from requireProjectAccess", async () => {
    requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "ws-42" } });

    await GET({} as never, makeParams());

    expect(workspaceFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(workspaceFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "ws-42" },
      select: { billingPlan: true },
    });
  });
});
