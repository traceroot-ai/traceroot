import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    modelProvider: {
      findFirst: (...args: unknown[]) => modelProviderFindFirstMock(...args),
    },
  },
}));

import { validateWorkspaceModelSelection } from "./model-availability";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  modelProviderFindFirstMock.mockReset();
});

afterEach(() => {
  if (originalAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }
});

describe("validateWorkspaceModelSelection", () => {
  it("accepts configured system model tuples and canonicalizes provider keys", async () => {
    const result = await validateWorkspaceModelSelection("workspace-1", {
      source: "system",
      provider: "Anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(result).toEqual({
      ok: true,
      source: "system",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(modelProviderFindFirstMock).not.toHaveBeenCalled();
  });

  it("accepts lower-case system provider keys from persisted detector payloads", async () => {
    const result = await validateWorkspaceModelSelection("workspace-1", {
      source: "system",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(result).toEqual({
      ok: true,
      source: "system",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("rejects system models when the provider env var is unavailable", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await validateWorkspaceModelSelection("workspace-1", {
      source: "system",
      provider: "Anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("normalizes whitespace-padded model tuples", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      adapter: "openai",
      customModels: ["gpt-5.4-mini"],
    });

    const result = await validateWorkspaceModelSelection("workspace-1", {
      source: " byok ",
      provider: " local-openai ",
      model: " gpt-5.4-mini ",
    });

    expect(result).toEqual({
      ok: true,
      source: "byok",
      provider: "local-openai",
      model: "gpt-5.4-mini",
    });
  });

  it("accepts configured and supported BYOK model tuples", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      adapter: "openai",
      customModels: [" gpt-5.4-mini "],
    });

    const result = await validateWorkspaceModelSelection("workspace-1", {
      source: "byok",
      provider: "local-openai",
      model: "gpt-5.4-mini",
    });

    expect(result).toEqual({
      ok: true,
      source: "byok",
      provider: "local-openai",
      model: "gpt-5.4-mini",
    });
    expect(modelProviderFindFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", provider: "local-openai", enabled: true },
      select: { adapter: true, customModels: true },
    });
  });

  it("rejects BYOK providers that are not configured for the workspace", async () => {
    modelProviderFindFirstMock.mockResolvedValue(null);

    const result = await validateWorkspaceModelSelection("workspace-1", {
      source: "byok",
      provider: "local-openai",
      model: "gpt-5.4-mini",
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "Selected BYOK provider is not configured for this workspace",
    });
  });

  it("rejects BYOK models outside the provider catalog", async () => {
    modelProviderFindFirstMock.mockResolvedValue({
      adapter: "openai",
      customModels: ["unsupported-local"],
    });

    const result = await validateWorkspaceModelSelection("workspace-1", {
      source: "byok",
      provider: "local-openai",
      model: "unsupported-local",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      message: "Selected BYOK model is not supported by this provider",
    });
  });

  it("resolves detector defaults to the first configured system provider", async () => {
    const result = await validateWorkspaceModelSelection(
      "workspace-1",
      { source: "system", provider: undefined, model: undefined },
      { allowDefaultSystem: true },
    );

    expect(result).toEqual({
      ok: true,
      source: "system",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("rejects detector defaults when no system provider is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await validateWorkspaceModelSelection(
      "workspace-1",
      { source: "system", provider: undefined, model: undefined },
      { allowDefaultSystem: true },
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "No system model provider is available for this workspace",
    });
  });

  it("rejects null detector defaults even when default system models are allowed", async () => {
    const result = await validateWorkspaceModelSelection(
      "workspace-1",
      { source: null, provider: undefined, model: undefined },
      { allowDefaultSystem: true },
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "source is required for model selection",
    });
  });

  it("requires concrete tuples for interactive AI calls", async () => {
    const result = await validateWorkspaceModelSelection("workspace-1", {
      source: "system",
      provider: undefined,
      model: undefined,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});
