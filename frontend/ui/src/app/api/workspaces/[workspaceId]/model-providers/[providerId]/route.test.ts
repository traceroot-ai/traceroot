import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const modelProviderFindFirstMock = vi.fn();
const modelProviderDuplicateMock = vi.fn();
const modelProviderUpdateMock = vi.fn();

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
    baseUrl: null,
    keyCipher: "old-cipher",
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
    const res = await PATCH(makeRequest({ provider: "Claude", enabled: false }), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("Claude");
    expect(body.enabled).toBe(false);
    expect(modelProviderDuplicateMock).not.toHaveBeenCalled();
    expect(modelProviderUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("updates provider successfully when renamed to an unused name", async () => {
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
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const res = await PATCH(makeRequest({ provider: "New Claude Name" }), makeParams());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A provider with this name already exists in this workspace");
    expect(modelProviderUpdateMock).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH model-providers/[providerId] - credential destination binding", () => {
  it.each(["https://collector.example/v1", null])(
    "requires a replacement key when changing the destination to %j",
    async (baseUrl) => {
      modelProviderFindFirstMock.mockResolvedValue({
        id: "mp-1",
        workspaceId: "ws-1",
        adapter: "openai",
        provider: "OpenAI",
        baseUrl: "https://original.example/v1",
        keyCipher: "old-cipher",
        config: null,
      });
      const res = await PATCH(makeRequest({ baseUrl }), makeParams());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Re-enter credentials when changing the Base URL.",
      });
      expect(modelProviderUpdateMock).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("allows an unchanged destination without replacing the key", async () => {
    const res = await PATCH(makeRequest({ baseUrl: null, enabled: false }), makeParams());
    expect(res.status).toBe(200);
    expect(modelProviderUpdateMock.mock.calls[0][0].data).toMatchObject({
      baseUrl: null,
      enabled: false,
    });
  });

  it("replaces the destination and credential together", async () => {
    const res = await PATCH(
      makeRequest({ baseUrl: "https://new.example/v1", apiKey: "new-key" }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(modelProviderUpdateMock).toHaveBeenCalledWith({
      where: { id: "mp-1", workspaceId: "ws-1", baseUrl: null, keyCipher: "old-cipher" },
      data: {
        baseUrl: "https://new.example/v1",
        keyCipher: "enc(new-key)",
        keyPreview: "mask(new-key)",
      },
      select: {
        id: true,
        adapter: true,
        provider: true,
        keyPreview: true,
        baseUrl: true,
        customModels: true,
        withDefaultModels: true,
        config: true,
        enabled: true,
        createdBy: true,
        createTime: true,
        updateTime: true,
      },
    });
  });

  it("keeps the credential ciphertext out of the update response", async () => {
    modelProviderUpdateMock.mockImplementation(
      async ({
        data,
        select,
      }: {
        data: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        const row = { id: "mp-1", ...data };
        return select
          ? Object.fromEntries(Object.entries(row).filter(([field]) => select[field]))
          : row;
      },
    );
    const res = await PATCH(makeRequest({ apiKey: "new-key" }), makeParams());
    expect(await res.json()).toEqual({ id: "mp-1", keyPreview: "mask(new-key)" });
  });

  it.each([{}, { apiKey: "not-an-aws-replacement" }, { awsAccessKeyId: "AKIAEXAMPLE" }])(
    "cannot redirect saved Bedrock credentials without replacing them (%j)",
    async (credentials) => {
      modelProviderFindFirstMock.mockResolvedValue({
        id: "mp-1",
        workspaceId: "ws-1",
        adapter: "amazon-bedrock",
        provider: "Bedrock",
        baseUrl: null,
        keyCipher: "old-aws-cipher",
        config: null,
      });
      const res = await PATCH(
        makeRequest({ baseUrl: "https://collector.example", ...credentials }),
        makeParams(),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Re-enter credentials when changing the Base URL.",
      });
      expect(modelProviderUpdateMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { awsAccessKeyId: "AKIAEXAMPLE", awsSecretAccessKey: "new-secret" },
    { useDefaultCredentials: true },
  ])("can replace Bedrock credentials together with a destination (%j)", async (credentials) => {
    modelProviderFindFirstMock.mockResolvedValue({
      id: "mp-1",
      workspaceId: "ws-1",
      adapter: "amazon-bedrock",
      provider: "Bedrock",
      baseUrl: null,
      keyCipher: "old-aws-cipher",
      config: null,
    });
    const res = await PATCH(
      makeRequest({ baseUrl: "https://new.example", ...credentials }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    const { data } = modelProviderUpdateMock.mock.calls[0][0];
    expect(data.baseUrl).toBe("https://new.example");
    expect(data.keyCipher).toBe(
      "useDefaultCredentials" in credentials
        ? "enc(__BEDROCK_DEFAULT_CREDENTIALS__)"
        : 'enc({"awsAccessKeyId":"AKIAEXAMPLE","awsSecretAccessKey":"new-secret"})',
    );
  });

  it("rejects a stale key rotation after a concurrent destination change", async () => {
    modelProviderUpdateMock.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (where.keyCipher === "old-cipher" && where.baseUrl === null) {
          throw Object.assign(new Error("Record changed"), { code: "P2025" });
        }
        return { baseUrl: "https://collector.example/v1", keyCipher: "enc(new-key)" };
      },
    );
    const res = await PATCH(makeRequest({ apiKey: "new-key" }), makeParams());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Model provider changed. Reload and try again." });
    expect(fetch).not.toHaveBeenCalled();
  });
});
