import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireAuth = vi.fn();
const mockRequireWorkspaceMembership = vi.fn();
const mockFindFirst = vi.fn();
const mockFindFirstProvider = vi.fn();
const mockProviderUpdate = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...a: any[]) => mockRequireAuth(...a),
  requireWorkspaceMembership: (...a: any[]) => mockRequireWorkspaceMembership(...a),
  errorResponse: (msg: string, s: number) =>
    new Response(JSON.stringify({ error: msg }), { status: s }),
  successResponse: (d: any, status = 200) => new Response(JSON.stringify(d), { status }),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    modelProvider: {
      findFirst: (args: any) => {
        // Distinguish finding the existing record vs checking for duplicate names
        if (args.where?.id && typeof args.where.id === "string") {
          return mockFindFirst(args);
        }
        return mockFindFirstProvider(args);
      },
      update: (...a: any[]) => mockProviderUpdate(...a),
    },
  },
  Role: { ADMIN: "ADMIN" },
  encryptKey: (k: string) => `encrypted_${k}`,
  maskKey: (k: string) => `masked_${k}`,
}));

describe("PATCH /api/workspaces/[workspaceId]/model-providers/[providerId]", () => {
  beforeEach(() => {
    mockRequireAuth.mockReset();
    mockRequireWorkspaceMembership.mockReset();
    mockFindFirst.mockReset();
    mockFindFirstProvider.mockReset();
    mockProviderUpdate.mockReset();
  });

  it("updates provider successfully when name is not changed", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" } });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockFindFirst.mockResolvedValue({
      id: "mp1",
      provider: "My OpenAI",
      adapter: "openai",
    });
    mockProviderUpdate.mockResolvedValue({
      id: "mp1",
      provider: "My OpenAI",
      adapter: "openai",
      enabled: false,
    });

    const { PATCH } = await import("./route");
    const req = new Request("http://localhost/", {
      method: "PATCH",
      body: JSON.stringify({
        enabled: false,
      }),
    });

    const res = await PATCH(req, {
      params: Promise.resolve({ workspaceId: "ws1", providerId: "mp1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(mockFindFirstProvider).not.toHaveBeenCalled();
    expect(mockProviderUpdate).toHaveBeenCalledTimes(1);
  });

  it("updates provider successfully when renamed to an unused name", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" } });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockFindFirst.mockResolvedValue({
      id: "mp1",
      provider: "My OpenAI",
      adapter: "openai",
    });
    mockFindFirstProvider.mockResolvedValue(null);
    mockProviderUpdate.mockResolvedValue({
      id: "mp1",
      provider: "New OpenAI Name",
      adapter: "openai",
    });

    const { PATCH } = await import("./route");
    const req = new Request("http://localhost/", {
      method: "PATCH",
      body: JSON.stringify({
        provider: "New OpenAI Name",
      }),
    });

    const res = await PATCH(req, {
      params: Promise.resolve({ workspaceId: "ws1", providerId: "mp1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("New OpenAI Name");
    expect(mockFindFirstProvider).toHaveBeenCalledTimes(1);
    expect(mockProviderUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns 409 Conflict when renamed to an existing provider name in workspace", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" } });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockFindFirst.mockResolvedValue({
      id: "mp1",
      provider: "My OpenAI",
      adapter: "openai",
    });
    mockFindFirstProvider.mockResolvedValue({
      id: "mp2",
      provider: "Existing Other Provider",
    });

    const { PATCH } = await import("./route");
    const req = new Request("http://localhost/", {
      method: "PATCH",
      body: JSON.stringify({
        provider: "Existing Other Provider",
      }),
    });

    const res = await PATCH(req, {
      params: Promise.resolve({ workspaceId: "ws1", providerId: "mp1" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(mockProviderUpdate).not.toHaveBeenCalled();
  });
});
