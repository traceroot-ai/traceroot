import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorFindFirstMock = vi.fn();
const detectorUpdateMock = vi.fn();
const detectorDeleteMock = vi.fn();
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
    openai: [{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" }],
  },
  prisma: {
    detector: {
      findFirst: (...args: unknown[]) => detectorFindFirstMock(...args),
      update: (...args: unknown[]) => detectorUpdateMock(...args),
      delete: (...args: unknown[]) => detectorDeleteMock(...args),
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

import { PATCH } from "./route";

const existingDetector = {
  id: "det-1",
  projectId: "proj-1",
  name: "Detector",
  prompt: "Find failures",
  detectionModel: "claude-4",
  detectionProvider: "Anthropic",
  detectionSource: "system",
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", detectorId: "det-1" }) };
}

beforeEach(() => {
  detectorFindFirstMock.mockReset();
  detectorUpdateMock.mockReset();
  detectorDeleteMock.mockReset();
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
  detectorFindFirstMock.mockResolvedValue(existingDetector);
  detectorUpdateMock.mockResolvedValue({ ...existingDetector });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PATCH .../detectors/[detectorId] — model selection validation", () => {
  it("does not revalidate the detector model tuple for unrelated updates", async () => {
    const res = await PATCH(makeRequest({ prompt: "New prompt" }), makeParams());

    expect(res.status).toBe(200);
    expect(modelProviderFindFirstMock).not.toHaveBeenCalled();
    expect(detectorUpdateMock.mock.calls[0][0].data).toEqual({ prompt: "New prompt" });
  });

  it("accepts and normalizes canonical system provider keys", async () => {
    const res = await PATCH(
      makeRequest({
        detectionModel: "claude-4",
        detectionProvider: "anthropic",
        detectionSource: "system",
      }),
      makeParams(),
    );

    expect(res.status).toBe(200);
    expect(detectorUpdateMock.mock.calls[0][0].data).toMatchObject({
      detectionModel: "claude-4",
      detectionProvider: "Anthropic",
      detectionSource: "system",
    });
  });

  it("rejects partial model tuple updates", async () => {
    const res = await PATCH(makeRequest({ detectionModel: "" }), makeParams());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Detector model selection is required. Choose a configured system model or BYOK provider.",
    });
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects unavailable system providers", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const res = await PATCH(
      makeRequest({
        detectionModel: "claude-4",
        detectionProvider: "Anthropic",
        detectionSource: "system",
      }),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Selected system provider is not available for this workspace",
    });
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported BYOK models", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      provider: "my-openai",
      adapter: "openai",
      customModels: ["not-supported"],
    });

    const res = await PATCH(
      makeRequest({
        detectionModel: "not-supported",
        detectionProvider: "my-openai",
        detectionSource: "byok",
      }),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Selected BYOK model is not supported by Traceroot",
    });
    expect(modelProviderFindFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", provider: "my-openai", enabled: true },
      select: { provider: true, adapter: true, customModels: true },
    });
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });
});
