import { beforeEach, describe, it, expect, vi } from "vitest";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  trace_ttl_days: z.number().int().min(1).max(365).nullable().optional(),
  rca_model: z.string().min(1).max(200).nullable().optional(),
  rca_provider: z.string().min(1).max(200).nullable().optional(),
  rca_source: z.string().min(1).max(200).nullable().optional(),
  alert_emails: z.array(z.string().email().max(254)).max(50).optional(),
});

const mockRequireAuth = vi.fn();
const mockRequireWorkspaceMembership = vi.fn();
const mockFindFirst = vi.fn();
const mockProjectUpdate = vi.fn();
const mockModelProviderFindFirst = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...a: any[]) => mockRequireAuth(...a),
  requireWorkspaceMembership: (...a: any[]) => mockRequireWorkspaceMembership(...a),
  errorResponse: (msg: string, s: number) =>
    new Response(JSON.stringify({ error: msg }), { status: s }),
  successResponse: (d: any) => new Response(JSON.stringify(d), { status: 200 }),
}));

vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    prisma: {
      project: {
        findFirst: (...a: any[]) => mockFindFirst(...a),
        update: (...a: any[]) => mockProjectUpdate(...a),
      },
      modelProvider: {
        findFirst: (...a: any[]) => mockModelProviderFindFirst(...a),
      },
    },
    Role: { ADMIN: "ADMIN" },
  };
});

const project = {
  id: "p1",
  workspaceId: "ws1",
  name: "test",
  traceTtlDays: 30,
  rcaModel: "gpt-5.3",
  rcaProvider: "my-openai",
  rcaSource: "byok",
  alertConfig: { emailAddresses: [] },
  accessKeys: [],
  createTime: new Date(),
  updateTime: new Date(),
};

const routePath = path.join(__dirname, "..", "[projectId]", "route.ts");

describe("Workspace project route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockModelProviderFindFirst.mockResolvedValue(null);
  });

  it("schema accepts rca_provider and rca_source", () => {
    const r = updateProjectSchema.safeParse({ rca_provider: "anthropic", rca_source: "system" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.rca_provider).toBe("anthropic");
      expect(r.data.rca_source).toBe("system");
    }
  });

  it("GET response includes rca_provider and rca_source", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" }, error: null });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockFindFirst.mockResolvedValue(project);

    const mod = await import(pathToFileURL(routePath).href);
    const res = await mod.GET(new Request("http://localhost/"), {
      params: Promise.resolve({ workspaceId: "ws1", projectId: "p1" }),
    });
    const body = await res.json();
    expect(body.rca_provider).toBe("my-openai");
    expect(body.rca_source).toBe("byok");
  });

  it("PATCH updates a complete RCA BYOK tuple", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" }, error: null });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockFindFirst.mockResolvedValue({ ...project });
    mockProjectUpdate.mockResolvedValue({
      ...project,
      rcaModel: "gpt-5.4-mini",
      rcaProvider: "my-openai",
      rcaSource: "byok",
    });
    mockModelProviderFindFirst.mockResolvedValue({
      adapter: "openai",
      customModels: ["gpt-5.4-mini"],
    });

    const mod = await import(pathToFileURL(routePath).href);
    const res = await mod.PATCH(
      new Request("http://localhost/", {
        method: "PATCH",
        body: JSON.stringify({
          rca_model: "gpt-5.4-mini",
          rca_provider: "my-openai",
          rca_source: "byok",
        }),
      }),
      { params: Promise.resolve({ workspaceId: "ws1", projectId: "p1" }) },
    );
    const body = await res.json();
    expect(body.rca_provider).toBe("my-openai");
    expect(body.rca_source).toBe("byok");
    expect(mockModelProviderFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", provider: "my-openai", enabled: true },
      select: { adapter: true, customModels: true },
    });
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rcaModel: "gpt-5.4-mini",
          rcaProvider: "my-openai",
          rcaSource: "byok",
        }),
      }),
    );
  });
});
