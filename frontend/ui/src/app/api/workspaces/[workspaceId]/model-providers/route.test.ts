import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireAuth = vi.fn();
const mockRequireWorkspaceMembership = vi.fn();
const mockWorkspaceFindUnique = vi.fn();
const mockProviderFindUnique = vi.fn();
const mockProviderCreate = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...a: any[]) => mockRequireAuth(...a),
  requireWorkspaceMembership: (...a: any[]) => mockRequireWorkspaceMembership(...a),
  errorResponse: (msg: string, s: number) =>
    new Response(JSON.stringify({ error: msg }), { status: s }),
  successResponse: (d: any, status = 200) => new Response(JSON.stringify(d), { status }),
}));

class MockPrismaClientKnownRequestError extends Error {
  code: string;
  constructor(message: string, { code }: { code: string }) {
    super(message);
    this.code = code;
  }
}

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: { findUnique: (...a: any[]) => mockWorkspaceFindUnique(...a) },
    modelProvider: {
      findUnique: (...a: any[]) => mockProviderFindUnique(...a),
      create: (...a: any[]) => mockProviderCreate(...a),
    },
  },
  Role: { ADMIN: "ADMIN" },
  hasEntitlement: () => true,
  encryptKey: (k: string) => `encrypted_${k}`,
  maskKey: (k: string) => `masked_${k}`,
  LLMAdapter: { OPENAI: "openai" },
  Prisma: {
    PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
  },
}));

describe("POST /api/workspaces/[workspaceId]/model-providers", () => {
  beforeEach(() => {
    mockRequireAuth.mockReset();
    mockRequireWorkspaceMembership.mockReset();
    mockWorkspaceFindUnique.mockReset();
    mockProviderFindUnique.mockReset();
    mockProviderCreate.mockReset();
  });

  it("creates a provider successfully when name is unique", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" } });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockWorkspaceFindUnique.mockResolvedValue({ billingPlan: "pro" });
    mockProviderFindUnique.mockResolvedValue(null);
    mockProviderCreate.mockResolvedValue({
      id: "mp1",
      provider: "My OpenAI",
      adapter: "openai",
    });

    const { POST } = await import("./route");
    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({
        adapter: "openai",
        provider: "My OpenAI",
        apiKey: "sk-proj-12345",
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ workspaceId: "ws1" }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider).toBe("My OpenAI");
    expect(mockProviderCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 409 Conflict when provider name already exists in workspace", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" } });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockWorkspaceFindUnique.mockResolvedValue({ billingPlan: "pro" });
    mockProviderFindUnique.mockResolvedValue({ id: "mp-existing", provider: "My OpenAI" });

    const { POST } = await import("./route");
    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({
        adapter: "openai",
        provider: "My OpenAI",
        apiKey: "sk-proj-12345",
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ workspaceId: "ws1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(mockProviderCreate).not.toHaveBeenCalled();
  });

  it("returns 409 Conflict when database throws unique constraint error on create", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" } });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockWorkspaceFindUnique.mockResolvedValue({ billingPlan: "pro" });
    mockProviderFindUnique.mockResolvedValue(null);
    mockProviderCreate.mockRejectedValue(
      new MockPrismaClientKnownRequestError("Unique constraint failed", { code: "P2002" }),
    );

    const { POST } = await import("./route");
    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({
        adapter: "openai",
        provider: "My OpenAI",
        apiKey: "sk-proj-12345",
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ workspaceId: "ws1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(mockProviderCreate).toHaveBeenCalledTimes(1);
  });
});
