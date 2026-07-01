import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentOptions: undefined as
    | {
        getApiKey: (provider: string) => Promise<string>;
      }
    | undefined,
  getEnvApiKey: vi.fn(),
  resolvePiModel: vi.fn(),
  fetchProviderConfig: vi.fn(),
  findByokKeyForPiProvider: vi.fn(),
  buildContext: vi.fn(),
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: vi.fn().mockImplementation((options) => {
    mocks.agentOptions = options;
    return {
      state: { messages: [] },
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(),
    };
  }),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getEnvApiKey: (...args: unknown[]) => mocks.getEnvApiKey(...args),
}));

vi.mock("@traceroot/core", () => ({
  ADAPTER_TO_PI_AI: { anthropic: "anthropic", openai: "openai" },
  BEDROCK_USE_DEFAULT_CREDENTIALS: "__bedrock_default_credentials__",
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));

vi.mock("@traceroot/core/model-resolver", () => ({
  resolvePiModel: (...args: unknown[]) => mocks.resolvePiModel(...args),
  fetchProviderConfig: (...args: unknown[]) => mocks.fetchProviderConfig(...args),
  findByokKeyForPiProvider: (...args: unknown[]) => mocks.findByokKeyForPiProvider(...args),
  invalidateProviderConfigCache: vi.fn(),
}));

vi.mock("../session.js", () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    buildContext: (...args: unknown[]) => mocks.buildContext(...args),
  })),
}));

import { ModelSource } from "@traceroot/core";
import { getOrCreateAgent, runAgent } from "../agent.js";

function baseConfig(extra: Partial<Parameters<typeof getOrCreateAgent>[0]> = {}) {
  return {
    sessionId: `session-${Math.random()}`,
    projectId: "project-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    systemPrompt: "system prompt",
    tools: [],
    model: "claude-sonnet-4-6",
    providerName: "anthropic",
    source: ModelSource.SYSTEM,
    ...extra,
  };
}

describe("getOrCreateAgent API key resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentOptions = undefined;
    mocks.resolvePiModel.mockReturnValue({ id: "claude-sonnet-4-6", provider: "anthropic" });
    mocks.buildContext.mockResolvedValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
    mocks.fetchProviderConfig.mockResolvedValue(null);
    mocks.findByokKeyForPiProvider.mockResolvedValue("workspace-byok-key");
  });

  it("does not fall back to workspace BYOK keys for system-source agents", async () => {
    await getOrCreateAgent(baseConfig({ source: ModelSource.SYSTEM }));

    const key = await mocks.agentOptions!.getApiKey("anthropic");

    expect(key).toBe("");
    expect(mocks.getEnvApiKey).toHaveBeenCalledWith("anthropic");
    expect(mocks.findByokKeyForPiProvider).not.toHaveBeenCalled();
  });

  it("uses the explicit BYOK provider key for BYOK-source agents", async () => {
    mocks.fetchProviderConfig.mockResolvedValueOnce({
      adapter: "anthropic",
      key: "explicit-byok-key",
      baseUrl: null,
      config: null,
    });

    await getOrCreateAgent(
      baseConfig({ source: ModelSource.BYOK, providerName: "workspace-anthropic" }),
    );

    const key = await mocks.agentOptions!.getApiKey("anthropic");

    expect(key).toBe("explicit-byok-key");
    expect(mocks.findByokKeyForPiProvider).not.toHaveBeenCalled();
  });

  it("requires an explicit provider for BYOK-source agents", async () => {
    await expect(
      getOrCreateAgent(baseConfig({ source: ModelSource.BYOK, providerName: undefined })),
    ).rejects.toThrow("BYOK provider is required");

    expect(mocks.fetchProviderConfig).not.toHaveBeenCalled();
    expect(mocks.findByokKeyForPiProvider).not.toHaveBeenCalled();
  });

  it("does not scan workspace or env keys when the selected BYOK provider does not match the requested provider", async () => {
    mocks.fetchProviderConfig.mockResolvedValueOnce({
      adapter: "openai",
      key: "openai-byok-key",
      baseUrl: null,
      config: null,
    });

    await getOrCreateAgent(
      baseConfig({ source: ModelSource.BYOK, providerName: "workspace-openai" }),
    );

    const key = await mocks.agentOptions!.getApiKey("anthropic");

    expect(key).toBe("");
    expect(mocks.getEnvApiKey).not.toHaveBeenCalled();
    expect(mocks.findByokKeyForPiProvider).not.toHaveBeenCalled();
  });
});

describe("runAgent abort handling", () => {
  it("aborts the active agent and suppresses completion/error callbacks when the signal aborts", async () => {
    const controller = new AbortController();
    let resolvePrompt: () => void = () => {};
    const promptPromise = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    const unsubscribe = vi.fn();
    const fakeAgent = {
      subscribe: vi.fn(() => unsubscribe),
      prompt: vi.fn(() => promptPromise),
      abort: vi.fn(() => resolvePrompt()),
    };
    const handler = {
      onEvent: vi.fn(),
      onError: vi.fn(),
      onDone: vi.fn(),
    };

    const run = runAgent(fakeAgent as unknown as Parameters<typeof runAgent>[0], "hello", handler, {
      signal: controller.signal,
    });
    controller.abort();
    await run;

    expect(fakeAgent.abort).toHaveBeenCalledTimes(1);
    expect(handler.onDone).not.toHaveBeenCalled();
    expect(handler.onError).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
