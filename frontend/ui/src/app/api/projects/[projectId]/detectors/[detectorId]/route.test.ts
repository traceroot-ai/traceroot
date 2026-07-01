import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorFindFirstMock = vi.fn();
const detectorUpdateMock = vi.fn();
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
      findFirst: (...args: unknown[]) => detectorFindFirstMock(...args),
      update: (...args: unknown[]) => detectorUpdateMock(...args),
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

import { PATCH } from "./route";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", detectorId: "det-1" }) };
}

const existingDetector = {
  id: "det-1",
  projectId: "proj-1",
  name: "My detector",
  prompt: "Find failures",
  detectionSource: "system",
  detectionProvider: "Anthropic",
  detectionModel: "claude-sonnet-4-6",
};

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  detectorFindFirstMock.mockReset();
  detectorUpdateMock.mockReset();
  modelProviderFindFirstMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "workspace-1" } });
  detectorFindFirstMock.mockResolvedValue(existingDetector);
  detectorUpdateMock.mockResolvedValue({ id: "det-1" });
});

afterEach(() => {
  if (originalAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }
});

describe("PATCH .../detectors/[detectorId] — model selection validation", () => {
  it("rejects non-object JSON payloads before updating", async () => {
    const res = await PATCH(makeRequest(null), makeParams());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Body must be a JSON object" });
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("canonicalizes system provider labels when updating detector model selection", async () => {
    const res = await PATCH(
      makeRequest({
        detectionSource: "system",
        detectionProvider: "Anthropic",
        detectionModel: "claude-sonnet-4-6",
      }),
      makeParams(),
    );

    expect(res.status).toBe(200);
    expect(detectorUpdateMock.mock.calls[0][0].data).toMatchObject({
      detectionSource: "system",
      detectionProvider: "anthropic",
      detectionModel: "claude-sonnet-4-6",
    });
  });

  it("canonicalizes the stored tuple when only one model field is patched", async () => {
    detectorFindFirstMock.mockResolvedValue({
      ...existingDetector,
      detectionSource: "system",
      detectionProvider: "Anthropic",
      detectionModel: "claude-sonnet-4-6",
    });

    const res = await PATCH(makeRequest({ detectionModel: "claude-sonnet-4-6" }), makeParams());

    expect(res.status).toBe(200);
    expect(detectorUpdateMock.mock.calls[0][0].data).toMatchObject({
      detectionSource: "system",
      detectionProvider: "anthropic",
      detectionModel: "claude-sonnet-4-6",
    });
  });

  it("treats legacy null detector sources as system when model fields are edited", async () => {
    detectorFindFirstMock.mockResolvedValue({
      ...existingDetector,
      detectionSource: null,
      detectionProvider: null,
      detectionModel: null,
    });

    const res = await PATCH(
      makeRequest({
        detectionProvider: "Anthropic",
        detectionModel: "claude-sonnet-4-6",
      }),
      makeParams(),
    );

    expect(res.status).toBe(200);
    expect(detectorUpdateMock.mock.calls[0][0].data).toMatchObject({
      detectionSource: "system",
      detectionProvider: "anthropic",
      detectionModel: "claude-sonnet-4-6",
    });
  });

  it("rejects BYOK detector models that are configured but unsupported", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      adapter: "openai",
      customModels: ["legacy-local"],
    });

    const res = await PATCH(
      makeRequest({
        detectionSource: "byok",
        detectionProvider: "local-openai",
        detectionModel: "legacy-local",
      }),
      makeParams(),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Selected BYOK model is not supported by this provider",
    });
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("stores a supported BYOK tuple when the workspace provider exposes it", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      adapter: "openai",
      customModels: ["gpt-5.4-mini"],
    });

    const res = await PATCH(
      makeRequest({
        detectionSource: "byok",
        detectionProvider: "local-openai",
        detectionModel: "gpt-5.4-mini",
      }),
      makeParams(),
    );

    expect(res.status).toBe(200);
    expect(detectorUpdateMock.mock.calls[0][0].data).toMatchObject({
      detectionSource: "byok",
      detectionProvider: "local-openai",
      detectionModel: "gpt-5.4-mini",
    });
  });

  it("does not revalidate legacy model fields during unrelated detector edits", async () => {
    detectorFindFirstMock.mockResolvedValue({
      ...existingDetector,
      detectionSource: "byok",
      detectionProvider: "local-openai",
      detectionModel: "legacy-local",
    });

    const res = await PATCH(makeRequest({ prompt: "Updated prompt" }), makeParams());

    expect(res.status).toBe(200);
    expect(modelProviderFindFirstMock).not.toHaveBeenCalled();
    expect(detectorUpdateMock.mock.calls[0][0].data).toMatchObject({ prompt: "Updated prompt" });
  });
});
