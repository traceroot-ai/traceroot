import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const workspaceFindUniqueMock = vi.fn();
const modelProviderFindUniqueMock = vi.fn();
const modelProviderCreateMock = vi.fn();

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
    workspace: { findUnique: (...args: unknown[]) => workspaceFindUniqueMock(...args) },
    modelProvider: {
      findUnique: (...args: unknown[]) => modelProviderFindUniqueMock(...args),
      create: (...args: unknown[]) => modelProviderCreateMock(...args),
    },
  },
  Role: { ADMIN: "ADMIN" },
  encryptKey: (key: string) => `enc(${key})`,
  maskKey: (key: string) => `mask(${key})`,
  hasEntitlement: () => true,
  LLMAdapter: {
    OPENAI: "openai",
    ANTHROPIC: "anthropic",
    AZURE: "azure",
    GOOGLE: "google",
    AMAZON_BEDROCK: "amazon-bedrock",
    DEEPSEEK: "deepseek",
    OPENROUTER: "openrouter",
    XAI: "xai",
    MOONSHOT: "moonshot",
    ZAI: "zai",
    TYPESAFE: "typesafe",
  },
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

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: "ws-1" }) };
}

beforeEach(() => {
  workspaceFindUniqueMock.mockReset();
  modelProviderFindUniqueMock.mockReset();
  modelProviderCreateMock.mockReset();
  requireAuthMock.mockReset();
  requireWorkspaceMembershipMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
  workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "pro" });
  modelProviderFindUniqueMock.mockResolvedValue(null);
  modelProviderCreateMock.mockImplementation(async (args: { data: unknown }) => ({
    id: "mp-1",
    ...(args.data as object),
  }));
});

describe("POST model-providers", () => {
  it("saves a TypeSafe AI provider with an encrypted key", async () => {
    const res = await POST(
      makeRequest({
        adapter: "typesafe",
        provider: "TypeSafe AI",
        apiKey: "ts-key",
        customModels: ["jev-1.13.0"],
        withDefaultModels: false,
      }),
      makeParams(),
    );

    expect(res.status).toBe(201);
    const { data } = modelProviderCreateMock.mock.calls[0][0];
    expect(data).toMatchObject({ adapter: "typesafe", keyCipher: "enc(ts-key)" });
  });

  it("creates a provider successfully when name is unique", async () => {
    const res = await POST(
      makeRequest({
        adapter: "openai",
        provider: "My OpenAI",
        apiKey: "sk-proj-12345",
      }),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(modelProviderFindUniqueMock).toHaveBeenCalledWith({
      where: {
        workspaceId_provider: { workspaceId: "ws-1", provider: "My OpenAI" },
      },
    });
    expect(modelProviderCreateMock).toHaveBeenCalledTimes(1);
  });

  it("returns 409 Conflict when provider name already exists in the workspace", async () => {
    modelProviderFindUniqueMock.mockResolvedValue({
      id: "existing-1",
      provider: "Existing Provider",
    });

    const res = await POST(
      makeRequest({
        adapter: "openai",
        provider: "Existing Provider",
        apiKey: "sk-proj-12345",
      }),
      makeParams(),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(modelProviderCreateMock).not.toHaveBeenCalled();
  });

  it("returns 409 Conflict when database throws unique constraint error on create", async () => {
    modelProviderFindUniqueMock.mockResolvedValue(null);
    modelProviderCreateMock.mockRejectedValue(
      new MockPrismaClientKnownRequestError("Unique constraint failed", { code: "P2002" }),
    );

    const res = await POST(
      makeRequest({
        adapter: "openai",
        provider: "Concurrent Provider",
        apiKey: "sk-proj-12345",
      }),
      makeParams(),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(modelProviderCreateMock).toHaveBeenCalledTimes(1);
  });
});
