import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const modelProviderFindFirstMock = vi.fn();
const modelProviderUpdateMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: {
    modelProvider: {
      findFirst: (...args: unknown[]) => modelProviderFindFirstMock(...args),
      update: (...args: unknown[]) => modelProviderUpdateMock(...args),
    },
  },
  Role: { ADMIN: "ADMIN" },
  encryptKey: (key: string) => `enc(${key})`,
  maskKey: (key: string) => `mask(${key})`,
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

import { PATCH } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: "ws-1", providerId: "mp-1" }) };
}

beforeEach(() => {
  modelProviderFindFirstMock.mockReset();
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
  modelProviderUpdateMock.mockImplementation(async (args: { data: unknown }) => args.data);
  // The handler tells the agent service to drop its cached provider config.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

describe("PATCH model-providers/[providerId]", () => {
  it.each(["   ", " "])("rejects a blank API key (%j) without saving it", async (blank) => {
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
});
