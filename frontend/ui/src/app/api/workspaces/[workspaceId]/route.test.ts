import { describe, it, expect, vi, afterEach } from "vitest";

const mockRequireAuth = vi.fn();
const mockRequireWorkspaceMembership = vi.fn();
const mockFindUnique = vi.fn();
const mockIsBillingEnabled = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...a: unknown[]) => mockRequireAuth(...a),
  requireWorkspaceMembership: (...a: unknown[]) => mockRequireWorkspaceMembership(...a),
  errorResponse: (msg: string, s: number) =>
    new Response(JSON.stringify({ error: msg }), { status: s }),
  successResponse: (d: unknown) => new Response(JSON.stringify(d), { status: 200 }),
}));

vi.mock("@traceroot/core", () => ({
  prisma: { workspace: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } },
  Role: { ADMIN: "ADMIN", MEMBER: "MEMBER" },
  isBillingEnabled: () => mockIsBillingEnabled(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const baseWorkspace = {
  id: "ws1",
  name: "Acme",
  projects: [],
  _count: { members: 1 },
  createTime: new Date("2026-01-01"),
  billingPlan: "free",
  billingCustomerId: null,
  billingSubscriptionId: null,
  billingStatus: null,
  currentUsage: null,
};

describe("GET /api/workspaces/[workspaceId]", () => {
  it("reports billingEnabled: true on a cloud deployment", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" }, error: null });
    mockRequireWorkspaceMembership.mockResolvedValue({
      membership: { role: "ADMIN" },
      error: null,
    });
    mockFindUnique.mockResolvedValue(baseWorkspace);
    mockIsBillingEnabled.mockReturnValue(true);

    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ workspaceId: "ws1" }),
    } as any);
    const body = await res.json();

    expect(body.billingEnabled).toBe(true);
  });

  it("reports billingEnabled: false on a self-host deployment (ENABLE_BILLING=false)", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" }, error: null });
    mockRequireWorkspaceMembership.mockResolvedValue({
      membership: { role: "ADMIN" },
      error: null,
    });
    mockFindUnique.mockResolvedValue(baseWorkspace);
    mockIsBillingEnabled.mockReturnValue(false);

    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ workspaceId: "ws1" }),
    } as any);
    const body = await res.json();

    expect(body.billingEnabled).toBe(false);
  });
});
