import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorCreateMock = vi.fn();
const modelProviderFindFirstMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
  PROVIDER_PRIORITY: ["anthropic", "openai"],
  SYSTEM_MODELS: [
    {
      provider: "Anthropic",
      envVar: "ANTHROPIC_API_KEY",
      piAIProvider: "anthropic",
      apiProtocol: "anthropic-messages",
      models: [{ id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" }],
    },
  ],
  ADAPTER_MODELS: {
    openai: [{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" }],
  },
  prisma: {
    detector: {
      create: (...args: unknown[]) => detectorCreateMock(...args),
    },
    modelProvider: {
      findFirst: (...args: unknown[]) => modelProviderFindFirstMock(...args),
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

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1" }) };
}

/** Minimal valid create payload — sampleRate intentionally omitted. */
function validBody(extra: Record<string, unknown> = {}) {
  return { name: "My detector", template: "failure", prompt: "Find failures", ...extra };
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  detectorCreateMock.mockReset();
  modelProviderFindFirstMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "workspace-1" } });
  detectorCreateMock.mockResolvedValue({ id: "det-1" });
});

afterEach(() => {
  if (originalAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }
});

describe("POST .../detectors — sampleRate default", () => {
  it("defaults sampleRate to 25 when omitted", async () => {
    const res = await POST(makeRequest(validBody()), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock).toHaveBeenCalledTimes(1);
    expect(detectorCreateMock.mock.calls[0][0].data.sampleRate).toBe(25);
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionSource: "system",
      detectionProvider: "anthropic",
      detectionModel: "claude-sonnet-4-6",
    });
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
  it("rejects explicit null detector sources instead of storing an ambiguous default", async () => {
    const res = await POST(makeRequest(validBody({ detectionSource: null })), makeParams());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: `detectionSource must be "system" or "byok"`,
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("stores a concrete system model only when that provider is available", async () => {
    const res = await POST(
      makeRequest(
        validBody({
          detectionSource: "system",
          detectionProvider: "Anthropic",
          detectionModel: "claude-sonnet-4-6",
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionSource: "system",
      detectionProvider: "anthropic",
      detectionModel: "claude-sonnet-4-6",
    });
  });

  it("rejects default system detector selection when no system provider is currently configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const res = await POST(makeRequest(validBody()), makeParams());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "No system model provider is available for this workspace",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("rejects BYOK detector models that are configured but unsupported", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      adapter: "openai",
      customModels: ["legacy-local"],
    });

    const res = await POST(
      makeRequest(
        validBody({
          detectionSource: "byok",
          detectionProvider: "local-openai",
          detectionModel: "legacy-local",
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Selected BYOK model is not supported by this provider",
    });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("rejects incomplete BYOK detector model tuples", async () => {
    const res = await POST(
      makeRequest(validBody({ detectionSource: "byok", detectionProvider: "local-openai" })),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });
});
