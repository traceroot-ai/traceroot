import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const findFirstMock = vi.fn();
const updateMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: {
    modelProvider: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
  Role: { ADMIN: "ADMIN" },
  encryptKey: (value: string) => `encrypted:${value}`,
  maskKey: (value: string) => `masked:${value}`,
  BEDROCK_USE_DEFAULT_CREDENTIALS: "__default_aws_credentials__",
}));

const requireAuthMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
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
  return { params: Promise.resolve({ workspaceId: "ws-1", providerId: "provider-1" }) };
}

beforeEach(() => {
  findFirstMock.mockReset();
  updateMock.mockReset();
  requireAuthMock.mockReset();
  requireWorkspaceMembershipMock.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockResolvedValue({});
  findFirstMock.mockResolvedValue({
    id: "provider-1",
    workspaceId: "ws-1",
    provider: "Test Gemini",
    adapter: "google",
    baseUrl: "https://example.com/v1testing",
    config: null,
  });
  updateMock.mockResolvedValue({
    id: "provider-1",
    provider: "Test Gemini",
    adapter: "google",
    baseUrl: null,
  });
});

describe("PATCH .../model-providers/[providerId] — baseUrl clearing", () => {
  it("persists explicit null so an edited Base URL can be cleared", async () => {
    const res = await PATCH(makeRequest({ baseUrl: null }), makeParams());

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].data).toMatchObject({ baseUrl: null });
  });

  it("leaves Base URL unchanged when omitted from a partial PATCH", async () => {
    const res = await PATCH(makeRequest({ provider: "Renamed Gemini" }), makeParams());

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].data).toMatchObject({ provider: "Renamed Gemini" });
    expect(updateMock.mock.calls[0][0].data).not.toHaveProperty("baseUrl");
  });
});
