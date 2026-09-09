import { describe, it, expect, vi } from "vitest";

const mockRequireAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockFindFirst = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...a: any[]) => mockRequireAuth(...a),
  requireProjectAccess: (...a: any[]) => mockRequireProjectAccess(...a),
  errorResponse: (msg: string, s: number) =>
    new Response(JSON.stringify({ error: msg }), { status: s }),
  successResponse: (d: any) => new Response(JSON.stringify(d), { status: 200 }),
}));

vi.mock("@traceroot/core", () => ({
  prisma: { project: { findFirst: (...a: any[]) => mockFindFirst(...a) } },
  DEFAULT_ALERT_WINDOW: "10m",
}));

describe("GET /api/projects/[projectId]", () => {
  it("includes rca_provider and rca_source in response", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" }, error: null });
    mockRequireProjectAccess.mockResolvedValue({ error: null });
    mockFindFirst.mockResolvedValue({
      id: "p1",
      workspaceId: "ws1",
      name: "test",
      traceTtlDays: 30,
      rcaModel: "gpt-5.3",
      rcaProvider: "my-openai",
      rcaSource: "byok",
      alertConfig: { emailAddresses: [] },
      _count: { accessKeys: 0 },
      createTime: new Date(),
      updateTime: new Date(),
    });

    const { GET } = await import("../[projectId]/route");
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ projectId: "p1" }),
    } as any);
    const body = await res.json();
    expect(body.rca_provider).toBe("my-openai");
    expect(body.rca_source).toBe("byok");
    // alertConfig has no alertWindow here, so the response uses the default.
    expect(body.alert_window).toBe("10m");
  });
});
