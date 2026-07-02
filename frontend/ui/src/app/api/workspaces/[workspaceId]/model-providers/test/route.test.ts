import { describe, it, expect, vi, beforeEach } from "vitest";

// Pin the connection timeout low (50ms) BEFORE the route module is imported, so
// timeout-path tests resolve fast and deterministically without fake timers.
vi.hoisted(() => {
  process.env.MODEL_PROVIDER_TEST_TIMEOUT_MS = "50";
});

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@traceroot/core", () => ({
  Role: { ADMIN: "ADMIN" },
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
  },
  ADAPTER_DEFAULT_BASE_URL: {
    deepseek: "https://api.deepseek.com/v1",
    xai: "https://api.x.ai/v1",
    moonshot: "https://api.moonshot.ai/v1",
    zai: "https://open.bigmodel.cn/api/paas/v4",
  },
  prisma: {
    modelProvider: {
      findFirst: (...args: unknown[]) => prismaFindFirstMock(...args),
    },
  },
  decryptKey: (...args: unknown[]) => decryptKeyMock(...args),
}));

const prismaFindFirstMock = vi.fn();
const decryptKeyMock = vi.fn();

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
import { withTimeout, resolveTimeoutMs } from "./timeout";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: "ws-1" }) };
}

// A fetch stub that NEVER responds but honors the abort signal — modeling a host
// that accepts the socket then stalls. Real undici fetch rejects on abort; a
// plain never-resolving promise would not, and would hang the test instead.
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }
      }),
  );
}

function okResponse() {
  return { ok: true, status: 200, statusText: "OK" };
}

beforeEach(() => {
  fetchMock.mockReset();
  prismaFindFirstMock.mockReset();
  decryptKeyMock.mockReset();
  requireAuthMock.mockReset();
  requireWorkspaceMembershipMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
});

describe("resolveTimeoutMs", () => {
  it("defaults to 10000 when unset, empty, or non-numeric", () => {
    expect(resolveTimeoutMs(undefined)).toBe(10_000);
    expect(resolveTimeoutMs("")).toBe(10_000);
    expect(resolveTimeoutMs("abc")).toBe(10_000);
  });

  it("falls back to default for zero, negative, and sub-1ms values", () => {
    expect(resolveTimeoutMs("0")).toBe(10_000);
    expect(resolveTimeoutMs("-5")).toBe(10_000);
    // Would otherwise floor to 0 and fire setTimeout(abort, 0) before any fetch.
    expect(resolveTimeoutMs("0.5")).toBe(10_000);
  });

  it("caps absurdly large values at 60000", () => {
    expect(resolveTimeoutMs("999999999")).toBe(60_000);
  });

  it("uses a valid in-range value", () => {
    expect(resolveTimeoutMs("5000")).toBe(5_000);
  });

  it("floors fractional values to whole milliseconds", () => {
    expect(resolveTimeoutMs("1500.9")).toBe(1_500);
  });
});

describe("withTimeout", () => {
  it("returns the operation result when it settles in time", async () => {
    const result = await withTimeout(async () => "ok", 1000);
    expect(result).toBe("ok");
  });

  it("throws a timeout error when the operation never settles", async () => {
    await expect(
      withTimeout(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        20,
      ),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("stays armed across multiple awaits (e.g. a hanging body read)", async () => {
    // First await resolves (headers arrived); the second hangs until abort.
    await expect(
      withTimeout(async (signal) => {
        await Promise.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }, 20),
    ).rejects.toThrow(/timed out/);
  });

  it("rethrows non-abort errors unchanged", async () => {
    await expect(
      withTimeout(async () => {
        throw new Error("boom");
      }, 1000),
    ).rejects.toThrow("boom");
  });
});

describe("POST model-providers/test - auth & validation", () => {
  it("returns the auth error when unauthenticated", async () => {
    const authError = { status: 401, json: async () => ({ error: "Unauthorized" }) };
    requireAuthMock.mockResolvedValue({ error: authError });
    const res = await POST(makeRequest({ adapter: "openai", apiKey: "k" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns the membership error when not an admin member", async () => {
    const memErr = { status: 403, json: async () => ({ error: "Not a member" }) };
    requireWorkspaceMembershipMock.mockResolvedValue({ error: memErr });
    const res = await POST(makeRequest({ adapter: "openai", apiKey: "k" }), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = {
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("returns 400 when the adapter is invalid", async () => {
    const res = await POST(makeRequest({ adapter: "not-a-provider" }), makeParams());
    expect(res.status).toBe(400);
  });
});

describe("POST model-providers/test - network providers succeed", () => {
  const cases: Array<{ name: string; body: Record<string, unknown>; url: string }> = [
    {
      name: "openai",
      body: { adapter: "openai", apiKey: "k" },
      url: "https://api.openai.com/v1/models",
    },
    {
      name: "openai with baseUrl",
      body: { adapter: "openai", apiKey: "k", baseUrl: "https://proxy.test/" },
      url: "https://proxy.test/v1/models",
    },
    {
      name: "google",
      body: { adapter: "google", apiKey: "k" },
      url: "https://generativelanguage.googleapis.com/v1beta/models",
    },
    {
      name: "openrouter",
      body: { adapter: "openrouter", apiKey: "k" },
      url: "https://openrouter.ai/api/v1/models",
    },
    {
      name: "deepseek",
      body: { adapter: "deepseek", apiKey: "k" },
      url: "https://api.deepseek.com/v1/models",
    },
    { name: "xai", body: { adapter: "xai", apiKey: "k" }, url: "https://api.x.ai/v1/models" },
    {
      name: "moonshot",
      body: { adapter: "moonshot", apiKey: "k" },
      url: "https://api.moonshot.ai/v1/models",
    },
    {
      name: "zai",
      body: { adapter: "zai", apiKey: "k" },
      url: "https://open.bigmodel.cn/api/paas/v4/models",
    },
    {
      name: "azure",
      body: { adapter: "azure", apiKey: "k", baseUrl: "https://my.openai.azure.com/" },
      url: "https://my.openai.azure.com/models?api-version=2024-06-01",
    },
  ];

  for (const c of cases) {
    it(`${c.name} returns success and passes an abort signal`, async () => {
      fetchMock.mockResolvedValue(okResponse());
      const res = await POST(makeRequest(c.body), makeParams());
      expect(await res.json()).toEqual({ success: true });
      expect(fetchMock).toHaveBeenCalledWith(
        c.url,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  }

  it("anthropic returns success on a 200 response", async () => {
    fetchMock.mockResolvedValue(okResponse());
    const res = await POST(makeRequest({ adapter: "anthropic", apiKey: "k" }), makeParams());
    expect(await res.json()).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });
});

describe("POST model-providers/test - error responses", () => {
  // Every status-code-based provider surfaces the same HTTP error shape.
  const httpErrorAdapters: Array<Record<string, unknown>> = [
    { adapter: "openai", apiKey: "k" },
    { adapter: "google", apiKey: "k" },
    { adapter: "openrouter", apiKey: "k" },
    { adapter: "deepseek", apiKey: "k" },
    { adapter: "xai", apiKey: "k" },
    { adapter: "moonshot", apiKey: "k" },
    { adapter: "zai", apiKey: "k" },
    { adapter: "azure", apiKey: "k", baseUrl: "https://my.openai.azure.com/" },
  ];

  for (const body of httpErrorAdapters) {
    it(`${body.adapter} returns success:false with an HTTP status error on non-ok`, async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
      const res = await POST(makeRequest(body), makeParams());
      expect(await res.json()).toEqual({
        success: false,
        error: "HTTP 500: Internal Server Error",
      });
    });
  }

  it("anthropic 401 maps to Invalid API key", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" });
    const res = await POST(makeRequest({ adapter: "anthropic", apiKey: "bad" }), makeParams());
    expect(await res.json()).toEqual({ success: false, error: "Invalid API key" });
  });

  it("anthropic non-401 errors are treated as connectable (success)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request" });
    const res = await POST(makeRequest({ adapter: "anthropic", apiKey: "k" }), makeParams());
    expect(await res.json()).toEqual({ success: true });
  });

  it("surfaces the provider's own error message when the body has one", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: { message: "Incorrect API key provided" } }),
    });
    const res = await POST(makeRequest({ adapter: "openai", apiKey: "bad" }), makeParams());
    expect(await res.json()).toEqual({ success: false, error: "Incorrect API key provided" });
  });

  it("anthropic 401 surfaces the provider error message when present", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: { message: "invalid x-api-key" } }),
    });
    const res = await POST(makeRequest({ adapter: "anthropic", apiKey: "bad" }), makeParams());
    expect(await res.json()).toEqual({ success: false, error: "invalid x-api-key" });
  });

  it("azure without baseUrl fails before any network call", async () => {
    const res = await POST(makeRequest({ adapter: "azure", apiKey: "k" }), makeParams());
    expect(await res.json()).toEqual({
      success: false,
      error: "Base URL is required for Azure OpenAI",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST model-providers/test - amazon-bedrock (no network)", () => {
  it("accepts default credentials", async () => {
    const res = await POST(
      makeRequest({ adapter: "amazon-bedrock", useDefaultCredentials: true }),
      makeParams(),
    );
    expect(await res.json()).toEqual({ success: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires access key id and secret", async () => {
    const res = await POST(makeRequest({ adapter: "amazon-bedrock" }), makeParams());
    expect(await res.json()).toEqual({
      success: false,
      error: "AWS Access Key ID and Secret Access Key are required",
    });
  });

  it("rejects an invalid access key id format", async () => {
    const res = await POST(
      makeRequest({ adapter: "amazon-bedrock", awsAccessKeyId: "NOPE", awsSecretAccessKey: "s" }),
      makeParams(),
    );
    expect(await res.json()).toEqual({ success: false, error: "Invalid AWS Access Key ID format" });
  });

  it("accepts a well-formed AKIA access key id", async () => {
    const res = await POST(
      makeRequest({
        adapter: "amazon-bedrock",
        awsAccessKeyId: "AKIAEXAMPLE",
        awsSecretAccessKey: "s",
      }),
      makeParams(),
    );
    expect(await res.json()).toEqual({ success: true });
  });
});

describe("POST model-providers/test - stored key resolution", () => {
  it("decrypts the stored key when only providerId is supplied", async () => {
    prismaFindFirstMock.mockResolvedValue({ keyCipher: "cipher" });
    decryptKeyMock.mockReturnValue("decrypted-key");
    fetchMock.mockResolvedValue(okResponse());

    const res = await POST(makeRequest({ adapter: "openai", providerId: "prov-1" }), makeParams());

    expect(await res.json()).toEqual({ success: true });
    expect(decryptKeyMock).toHaveBeenCalledWith("cipher");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer decrypted-key" } }),
    );
  });

  it("proceeds without a key when the providerId is not found", async () => {
    prismaFindFirstMock.mockResolvedValue(null);
    fetchMock.mockResolvedValue(okResponse());

    const res = await POST(makeRequest({ adapter: "openai", providerId: "missing" }), makeParams());

    expect(await res.json()).toEqual({ success: true });
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer undefined" } }),
    );
  });
});

describe("POST model-providers/test - timeout (acceptance criteria)", () => {
  it("returns success:false with a timed-out error when the provider never responds", async () => {
    fetchMock.mockImplementation(hangingFetch());

    const start = Date.now();
    const res = await POST(makeRequest({ adapter: "openai", apiKey: "k" }), makeParams());
    const elapsed = Date.now() - start;

    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/timed out/i);
    // Bounded well under any real provider timeout (module pinned to 50ms above).
    expect(elapsed).toBeLessThan(2000);
  });

  it("surfaces an ordinary fetch rejection as a non-timeout failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(makeRequest({ adapter: "openai", apiKey: "k" }), makeParams());
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("ECONNREFUSED");
    expect(body.error).not.toMatch(/timed out/i);
  });

  it("times out when headers arrive but the error body read stalls", async () => {
    // Models a host that returns a non-ok status, then never finishes the body.
    // The body read runs inside withTimeout, so the deadline still fires and we
    // must report a timeout — not swallow the abort into an HTTP status error.
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      }),
    );
    const res = await POST(makeRequest({ adapter: "openai", apiKey: "k" }), makeParams());
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/timed out/i);
  });

  it("times out when the anthropic 401 body read stalls", async () => {
    // The anthropic branch has its own inline withTimeout + body read; a 401
    // whose body never finishes must still abort at the deadline.
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      }),
    );
    const res = await POST(makeRequest({ adapter: "anthropic", apiKey: "bad" }), makeParams());
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/timed out/i);
  });
});
