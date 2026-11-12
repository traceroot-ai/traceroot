import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const modelProviderFindFirstMock = vi.fn();
const modelProviderDuplicateMock = vi.fn();
const modelProviderUpdateMock = vi.fn();

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
      findFirst: (args: { where?: { id?: unknown } }) => {
        // Distinguish finding the existing record vs checking for duplicate names
        if (typeof args.where?.id === "string") {
          return modelProviderFindFirstMock(args);
        }
        return modelProviderDuplicateMock(args);
      },
      update: (...args: unknown[]) => modelProviderUpdateMock(...args),
    },
  },
  Role: { ADMIN: "ADMIN" },
  encryptKey: (key: string) => `enc(${key})`,
  maskKey: (key: string) => `mask(${key})`,
  BEDROCK_USE_DEFAULT_CREDENTIALS: "__BEDROCK_DEFAULT_CREDENTIALS__",
  Prisma: {
    PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
  },
}));

const requireAuthMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { PATCH } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: "ws-1", providerId: "mp-1" }) };
}

beforeEach(() => {
  modelProviderFindFirstMock.mockReset();
  modelProviderDuplicateMock.mockReset();
  modelProviderUpdateMock.mockReset();
  requireAuthMock.mockReset();
  requireWorkspaceMembershipMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
  modelProviderFindFirstMock.mockResolvedValue({
    id: "mp-1",
    workspaceId: "ws-1",
    adapter: "anthropic",
    provider: "Claude",
    config: null,
  });
  modelProviderDuplicateMock.mockResolvedValue(null);
  modelProviderUpdateMock.mockImplementation(async (args: { data: unknown }) => args.data);
  // The handler tells the agent service to drop its cached provider config.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

describe("PATCH model-providers/[providerId]", () => {
  it.each(["   ", "\u00a0"])("rejects a blank API key (%j) without saving it", async (blank) => {
    const res = await PATCH(makeRequest({ apiKey: blank }), makeParams());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "API key is required" });
    expect(modelProviderUpdateMock).not.toHaveBeenCalled();
  });

  it("stores a replacement key without surrounding whitespace", async () => {
    const res = await PATCH(makeRequest({ apiKey: "  sk-new-key  " }), makeParams());

    expect(res.status).toBe(200);
    expect(modelProviderUpdateMock.mock.calls[0][0].data).toMatchObject({
      keyCipher: "enc(sk-new-key)",
      keyPreview: "mask(sk-new-key)",
    });
  });

  it("updates provider successfully when name is not changed", async () => {
    modelProviderUpdateMock.mockResolvedValue({
      id: "mp-1",
      provider: "Claude",
      adapter: "anthropic",
      enabled: false,
    });

    const res = await PATCH(makeRequest({ enabled: false }), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(modelProviderDuplicateMock).not.toHaveBeenCalled();
    expect(modelProviderUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("updates provider successfully when renamed to an unused name", async () => {
    modelProviderUpdateMock.mockResolvedValue({
      id: "mp-1",
      provider: "New Claude Name",
      adapter: "anthropic",
    });

    const res = await PATCH(makeRequest({ provider: "New Claude Name" }), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("New Claude Name");
    expect(modelProviderDuplicateMock).toHaveBeenCalledTimes(1);
    expect(modelProviderUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("returns 409 Conflict when renamed to an existing provider name in workspace", async () => {
    modelProviderDuplicateMock.mockResolvedValue({
      id: "mp-2",
      provider: "Existing Other Provider",
    });

    const res = await PATCH(makeRequest({ provider: "Existing Other Provider" }), makeParams());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(modelProviderUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 409 Conflict when database throws unique constraint error on update", async () => {
    modelProviderUpdateMock.mockRejectedValue(
      new MockPrismaClientKnownRequestError("Unique constraint failed", { code: "P2002" }),
    );

    const res = await PATCH(makeRequest({ provider: "New Claude Name" }), makeParams());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(modelProviderUpdateMock).toHaveBeenCalledTimes(1);
  });
});
