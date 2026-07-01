import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorCreateMock = vi.fn();
const modelProviderFindFirstMock = vi.fn();
const modelProviderFindManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
  PROVIDER_PRIORITY: ["anthropic", "openai"],
  SYSTEM_MODELS: [
    {
      provider: "Anthropic",
      envVar: "ANTHROPIC_API_KEY",
      piAIProvider: "anthropic",
      models: [{ id: "claude-4", label: "Claude 4" }],
    },
  ],
  ADAPTER_MODELS: {
    anthropic: [{ id: "claude-workspace", label: "Claude Workspace" }],
    openai: [{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" }],
  },
  prisma: {
    detector: {
      create: (...args: unknown[]) => detectorCreateMock(...args),
    },
    modelProvider: {
      findFirst: (...args: unknown[]) => modelProviderFindFirstMock(...args),
      findMany: (...args: unknown[]) => modelProviderFindManyMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
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
  return { params: Promise.resolve({ projectId: "proj-1" }) };
}

/** Minimal valid create payload — sampleRate intentionally omitted. */
function validBody(extra: Record<string, unknown> = {}) {
  return {
    name: "My detector",
    template: "failure",
    prompt: "Find failures",
    detectionModel: "claude-4",
    detectionProvider: "Anthropic",
    detectionSource: "system",
    ...extra,
  };
}

function validBodyWithoutModel(extra: Record<string, unknown> = {}) {
  return { name: "My detector", template: "failure", prompt: "Find failures", ...extra };
}

beforeEach(() => {
  detectorCreateMock.mockReset();
  modelProviderFindFirstMock.mockReset();
  modelProviderFindManyMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({
    project: { id: "proj-1", workspaceId: "workspace-1", name: "Project" },
    membership: { workspaceId: "workspace-1", userId: "user-1", role: "MEMBER" },
  });
  detectorCreateMock.mockResolvedValue({ id: "det-1" });
  modelProviderFindManyMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST .../detectors — sampleRate default", () => {
  it("defaults sampleRate to 25 when omitted", async () => {
    const res = await POST(makeRequest(validBody()), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock).toHaveBeenCalledTimes(1);
    expect(detectorCreateMock.mock.calls[0][0].data.sampleRate).toBe(25);
  });

  it("keeps an explicit sampleRate (100) instead of the default", async () => {
    const res = await POST(makeRequest(validBody({ sampleRate: 100 })), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data.sampleRate).toBe(100);
  });

  it("rejects an out-of-range sampleRate", async () => {
    const res = await POST(makeRequest(validBody({ sampleRate: 101 })), makeParams());

    expect(res.status).toBe(400);
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST .../detectors — model selection validation", () => {
  it("defaults an omitted legacy model selection to an available system model", async () => {
    const res = await POST(makeRequest(validBodyWithoutModel()), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionModel: "claude-4",
      detectionProvider: "Anthropic",
      detectionSource: "system",
    });
  });

  it("rejects an omitted model selection when no provider is available", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const res = await POST(makeRequest(validBodyWithoutModel()), makeParams());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Detector model selection is required. Choose a configured system model or BYOK provider.",
    });
    expect(modelProviderFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", enabled: true },
      select: { provider: true, adapter: true, customModels: true },
      orderBy: [{ createTime: "asc" }, { id: "asc" }],
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("defaults an omitted legacy model selection to an available BYOK model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    modelProviderFindManyMock.mockResolvedValue([
      {
        provider: "my-openai",
        adapter: "openai",
        customModels: ["not-supported", "gpt-5.4-mini"],
      },
    ]);

    const res = await POST(makeRequest(validBodyWithoutModel()), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionModel: "gpt-5.4-mini",
      detectionProvider: "my-openai",
      detectionSource: "byok",
    });
  });

  it("defaults an omitted legacy model selection to BYOK before system for the same adapter priority", async () => {
    modelProviderFindManyMock.mockResolvedValue([
      {
        provider: "workspace-anthropic",
        adapter: "anthropic",
        customModels: ["claude-workspace"],
      },
    ]);

    const res = await POST(makeRequest(validBodyWithoutModel()), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionModel: "claude-workspace",
      detectionProvider: "workspace-anthropic",
      detectionSource: "byok",
    });
  });

  it("uses the stable provider order when defaulting among multiple same-adapter BYOK providers", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    modelProviderFindManyMock.mockResolvedValue([
      {
        provider: "first-openai",
        adapter: "openai",
        customModels: ["gpt-5.4-mini"],
      },
      {
        provider: "second-openai",
        adapter: "openai",
        customModels: ["gpt-5.4-mini"],
      },
    ]);

    const res = await POST(makeRequest(validBodyWithoutModel()), makeParams());

    expect(res.status).toBe(201);
    expect(modelProviderFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", enabled: true },
      select: { provider: true, adapter: true, customModels: true },
      orderBy: [{ createTime: "asc" }, { id: "asc" }],
    });
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionModel: "gpt-5.4-mini",
      detectionProvider: "first-openai",
      detectionSource: "byok",
    });
  });

  it("keeps provider priority ahead of BYOK-first ordering across different adapters", async () => {
    modelProviderFindManyMock.mockResolvedValue([
      {
        provider: "workspace-openai",
        adapter: "openai",
        customModels: ["gpt-5.4-mini"],
      },
    ]);

    const res = await POST(makeRequest(validBodyWithoutModel()), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionModel: "claude-4",
      detectionProvider: "Anthropic",
      detectionSource: "system",
    });
  });

  it("rejects partial model selections instead of guessing missing tuple fields", async () => {
    const res = await POST(
      makeRequest(validBodyWithoutModel({ detectionModel: "claude-4" })),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Detector model selection is required. Choose a configured system model or BYOK provider.",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("rejects blank model fields instead of treating them as omitted defaults", async () => {
    const res = await POST(
      makeRequest(
        validBodyWithoutModel({
          detectionModel: "",
          detectionProvider: "",
          detectionSource: null,
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Detector model selection is required. Choose a configured system model or BYOK provider.",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("rejects non-string model fields instead of treating them as omitted defaults", async () => {
    const res = await POST(
      makeRequest(
        validBodyWithoutModel({
          detectionModel: 123,
          detectionProvider: "Anthropic",
          detectionSource: "system",
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Detector model selection is required. Choose a configured system model or BYOK provider.",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("accepts canonical system provider keys and stores the catalog provider label", async () => {
    const res = await POST(
      makeRequest(validBody({ detectionProvider: "anthropic" })),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionModel: "claude-4",
      detectionProvider: "Anthropic",
      detectionSource: "system",
    });
  });

  it("rejects system models when the provider env var is unavailable", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const res = await POST(makeRequest(validBody()), makeParams());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Selected system provider is not available for this workspace",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("rejects unknown system models", async () => {
    const res = await POST(
      makeRequest(validBody({ detectionModel: "claude-does-not-exist" })),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Selected system model is not available for this workspace",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("accepts configured and supported BYOK models", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      provider: "my-openai",
      adapter: "openai",
      customModels: ["gpt-5.4-mini"],
    });

    const res = await POST(
      makeRequest(
        validBody({
          detectionModel: "gpt-5.4-mini",
          detectionProvider: "my-openai",
          detectionSource: "byok",
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(modelProviderFindFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", provider: "my-openai", enabled: true },
      select: { provider: true, adapter: true, customModels: true },
    });
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionModel: "gpt-5.4-mini",
      detectionProvider: "my-openai",
      detectionSource: "byok",
    });
  });

  it("rejects missing BYOK providers", async () => {
    modelProviderFindFirstMock.mockResolvedValue(null);

    const res = await POST(
      makeRequest(
        validBody({
          detectionModel: "gpt-5.4-mini",
          detectionProvider: "missing-provider",
          detectionSource: "byok",
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Selected BYOK provider is not available for this workspace",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("rejects BYOK models outside the supported adapter catalog", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      provider: "my-openai",
      adapter: "openai",
      customModels: ["not-supported"],
    });

    const res = await POST(
      makeRequest(
        validBody({
          detectionModel: "not-supported",
          detectionProvider: "my-openai",
          detectionSource: "byok",
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Selected BYOK model is not supported by Traceroot",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });
});
