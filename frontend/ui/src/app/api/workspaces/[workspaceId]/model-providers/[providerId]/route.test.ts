import { describe, it, expect, vi, beforeEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

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

const { MockPrismaClientKnownRequestError } = vi.hoisted(() => {
  class MockPrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, { code }: { code: string }) {
      super(message);
      this.code = code;
    }
  }
  return { MockPrismaClientKnownRequestError };
});

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
  Prisma: {
    PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
  },
}));

import { PATCH } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams(workspaceId = "ws1", providerId = "mp1") {
  return { params: Promise.resolve({ workspaceId, providerId }) };
}

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

    const res = await PATCH(makeRequest({ enabled: false }), makeParams());
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

    const res = await PATCH(makeRequest({ provider: "New OpenAI Name" }), makeParams());
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

    const res = await PATCH(makeRequest({ provider: "Existing Other Provider" }), makeParams());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(mockProviderUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 Conflict when database throws unique constraint error on update", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "u1" } });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
    mockFindFirst.mockResolvedValue({
      id: "mp1",
      provider: "My OpenAI",
      adapter: "openai",
    });
    mockFindFirstProvider.mockResolvedValue(null);
    mockProviderUpdate.mockRejectedValue(
      new MockPrismaClientKnownRequestError("Unique constraint failed", { code: "P2002" }),
    );

    const res = await PATCH(makeRequest({ provider: "New OpenAI Name" }), makeParams());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(mockProviderUpdate).toHaveBeenCalledTimes(1);
  });
});
