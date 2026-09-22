import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const workspaceFindUniqueMock = vi.fn();
const modelProviderUpsertMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: { findUnique: (...args: unknown[]) => workspaceFindUniqueMock(...args) },
    modelProvider: {
      upsert: (...args: unknown[]) => modelProviderUpsertMock(...args),
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
  modelProviderUpsertMock.mockReset();
  requireAuthMock.mockReset();
  requireWorkspaceMembershipMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
  workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "pro" });
  modelProviderUpsertMock.mockImplementation(async (args: { create: unknown }) => args.create);
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
    const { create } = modelProviderUpsertMock.mock.calls[0][0];
    expect(create).toMatchObject({ adapter: "typesafe", keyCipher: "enc(ts-key)" });
  });
});
