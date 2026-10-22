import { describe, expect, it, vi } from "vitest";
import * as piAi from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof piAi>();
  return { ...actual, getModel: vi.fn(actual.getModel) };
});

// The SDK's generic signature only accepts known registry ids. Exercise misses
// and future entries without constraining mocks to the current registry ids.
const registryLookup = vi.mocked(
  piAi.getModel as (provider: string, id: string) => Model<Api> | undefined,
);

// Mock prisma BEFORE importing the resolver so fetchProviderConfig hits the mock.
vi.mock("../lib/prisma", () => ({
  prisma: {
    modelProvider: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../lib/encryption", () => ({
  decryptKey: vi.fn().mockReturnValue("decrypted-key"),
}));

import {
  resolvePiModel,
  isSystemModelId,
  fetchProviderConfig,
  findByokKeyForPiProvider,
  invalidateProviderConfigCache,
  type ProviderModelConfig,
} from "../model-resolver.ts";
import { SYSTEM_MODELS, DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "../llm-providers.ts";
import { prisma } from "../lib/prisma.ts";

describe("resolvePiModel", () => {
  it("uses anthropic-messages for system Claude", () => {
    const m = resolvePiModel("claude-sonnet-4-5", null);
    expect(m.api).toBe("anthropic-messages");
    expect(m.provider).toBe("anthropic");
  });

  it("uses openai-responses for system OpenAI models", () => {
    for (const id of ["gpt-5", "gpt-5.4", "gpt-5.3-codex"]) {
      const m = resolvePiModel(id, null);
      expect(m.api, id).toBe("openai-responses");
      expect(m.provider).toBe("openai");
      expect(m.id).toBe(id);
    }
  });

  it("keeps the o-series on openai-completions (per-model catalog override)", () => {
    for (const id of ["o3"]) {
      expect(resolvePiModel(id, null).api, `system ${id}`).toBe("openai-completions");
      const cfg: ProviderModelConfig = {
        adapter: "openai",
        key: "sk-test",
        baseUrl: null,
        config: null,
      };
      expect(resolvePiModel(id, cfg).api, `byok ${id}`).toBe("openai-completions");
    }
  });

  it("uses openai-responses for BYOK OpenAI with no override", () => {
    const cfg: ProviderModelConfig = {
      adapter: "openai",
      key: "sk-test",
      baseUrl: null,
      config: null,
    };
    const m = resolvePiModel("gpt-5.6-sol", cfg);
    expect(m.api).toBe("openai-responses");
    expect(m.provider).toBe("openai");
  });

  it("uses openai-completions for BYOK DeepSeek with provider mapped to openai", () => {
    const cfg: ProviderModelConfig = {
      adapter: "deepseek",
      key: "sk-test",
      baseUrl: null,
      config: null,
    };
    const m = resolvePiModel("deepseek-chat", cfg);
    expect(m.api).toBe("openai-completions");
    expect(m.provider).toBe("openai");
    expect(m.baseUrl).toContain("deepseek");
  });

  it("falls back to first ADAPTER_MODELS entry for BYOK with no model id (NOT Anthropic)", () => {
    const cfg: ProviderModelConfig = {
      adapter: "deepseek",
      key: "sk-test",
      baseUrl: null,
      config: null,
    };
    const m = resolvePiModel(undefined, cfg);
    expect(m.provider).toBe("openai");
    expect(m.id).toMatch(/^deepseek-/);
    expect(m.id).not.toMatch(/claude/i);
  });

  it("throws (instead of substituting an Anthropic default) for free-text adapter with no model id", () => {
    // azure, amazon-bedrock, openrouter aren't in ADAPTER_MODELS; without explicit
    // modelId the resolver would have nothing sensible to use, so it must throw
    // rather than silently send "claude-sonnet-4-5" to a non-Anthropic provider.
    for (const adapter of ["azure", "amazon-bedrock", "openrouter"]) {
      const cfg: ProviderModelConfig = { adapter, key: "sk-test", baseUrl: null, config: null };
      expect(() => resolvePiModel(undefined, cfg)).toThrow(/no curated model catalog/i);
    }
  });

  it("throws (instead of substituting a system model) for a decision adapter", () => {
    const cfg: ProviderModelConfig = {
      adapter: "typesafe",
      key: "ts-secret-key",
      baseUrl: null,
      config: null,
    };
    expect(() => resolvePiModel(undefined, cfg)).toThrow(/decision model/i);
  });

  it("throws (instead of substituting a system model) for a decision model id with no BYOK row", () => {
    expect(() => resolvePiModel("jev-1.13.0", null)).toThrow(/decision model/i);
  });

  it("respects per-model modelProtocols override over adapter default", () => {
    // The escape hatch for OpenAI-compatible proxies that only speak chat completions.
    const cfg: ProviderModelConfig = {
      adapter: "openai",
      key: "sk-test",
      baseUrl: "https://proxy.example.com/v1",
      config: { modelProtocols: { "gpt-5": "openai-completions" } },
    };
    const m = resolvePiModel("gpt-5", cfg);
    expect(m.api).toBe("openai-completions");
  });

  it("uses caller-supplied baseUrl over adapter default", () => {
    const cfg: ProviderModelConfig = {
      adapter: "openai",
      key: "sk-test",
      baseUrl: "https://custom.example.com/v1",
      config: null,
    };
    const m = resolvePiModel("gpt-5", cfg);
    expect(m.baseUrl).toBe("https://custom.example.com/v1");
  });

  it.each([
    { adapter: "zai", id: "glm-4.5", contextWindow: 131072, maxTokens: 98304 },
    { adapter: "zai", id: "glm-4.5-air", contextWindow: 131072, maxTokens: 98304 },
    { adapter: "google", id: "gemini-3.6-flash", contextWindow: 1048576, maxTokens: 65536 },
    { adapter: "google", id: "gemini-3.8-flash", contextWindow: 1048576, maxTokens: 65536 },
  ])(
    "uses documented fallback limits for $adapter/$id and preserves routing overrides",
    ({ adapter, id, contextWindow, maxTokens }) => {
      const lookup = registryLookup.mockReturnValue(undefined);
      try {
        const cfg: ProviderModelConfig = {
          adapter,
          key: "workspace-secret",
          baseUrl: "https://proxy.example.com/v1",
          config: { modelProtocols: { [id]: "openai-completions" } },
        };
        expect(resolvePiModel(id, cfg)).toMatchObject({
          id,
          provider: adapter === "zai" ? "openai" : "google",
          api: "openai-completions",
          baseUrl: cfg.baseUrl,
          contextWindow,
          maxTokens,
          reasoning: adapter === "google",
        });
      } finally {
        lookup.mockReset();
      }
    },
  );

  it("prefers future registry metadata while retaining workspace routing overrides", () => {
    const registered = {
      ...piAi.getModel("google", "gemini-3-flash-preview"),
      id: "gemini-3.8-flash",
      contextWindow: 1234567,
    };
    const lookup = registryLookup.mockReturnValueOnce(registered);
    try {
      expect(
        resolvePiModel(registered.id, {
          adapter: "google",
          key: "workspace-secret",
          baseUrl: "https://proxy.example.com/v1",
          config: { modelProtocols: { [registered.id]: "openai-completions" } },
        }),
      ).toEqual({
        ...registered,
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
      });
      expect(registered.api).toBe("google-generative-ai");
    } finally {
      lookup.mockReset();
    }
  });

  it("keeps unknown models and matching ids on unrelated adapters on the generic fallback", () => {
    for (const [adapter, id] of [
      ["zai", "custom-model"],
      ["openai", "glm-4.5"],
      ["openai", "gemini-3.8-flash"],
    ]) {
      expect(
        resolvePiModel(id, { adapter, key: "workspace-secret", baseUrl: null, config: null }),
      ).toMatchObject({ contextWindow: 200000, maxTokens: 64000, reasoning: false });
    }
  });
});

describe("fetchProviderConfig", () => {
  it("returns null when no row found", async () => {
    (prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const cfg = await fetchProviderConfig("ws-1", "missing-provider");
    expect(cfg).toBeNull();
  });

  it("returns null when row is disabled", async () => {
    (prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      adapter: "deepseek",
      keyCipher: "cipher",
      enabled: false,
      baseUrl: null,
      config: null,
    });
    const cfg = await fetchProviderConfig("ws-1", "deepseek");
    expect(cfg).toBeNull();
  });

  it("returns decrypted config when row exists and enabled", async () => {
    (prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      adapter: "deepseek",
      keyCipher: "cipher",
      enabled: true,
      baseUrl: "https://api.deepseek.com/v1",
      config: { modelProtocols: { foo: "openai-completions" } },
    });
    const cfg = await fetchProviderConfig("ws-1", "deepseek");
    expect(cfg).toEqual({
      adapter: "deepseek",
      key: "decrypted-key",
      baseUrl: "https://api.deepseek.com/v1",
      config: { modelProtocols: { foo: "openai-completions" } },
    });
  });

  it("returns null and does not throw on DB error", async () => {
    // Invalidate cache for ws-1:deepseek to avoid pollution from prior test.
    invalidateProviderConfigCache("ws-1", "deepseek");
    (prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection lost"),
    );
    const cfg = await fetchProviderConfig("ws-1", "deepseek");
    expect(cfg).toBeNull();
  });
});

describe("findByokKeyForPiProvider", () => {
  it("returns key from first BYOK row whose adapter maps to the requested pi-ai provider", async () => {
    invalidateProviderConfigCache("ws-2", "my-claude");
    (prisma.modelProvider.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { provider: "my-claude", adapter: "anthropic" },
      { provider: "my-openai", adapter: "openai" },
    ]);
    (prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      adapter: "anthropic",
      keyCipher: "cipher",
      enabled: true,
      baseUrl: null,
      config: null,
    });
    const key = await findByokKeyForPiProvider("ws-2", "anthropic");
    expect(key).toBe("decrypted-key");
  });

  it("matches BYOK rows whose adapter is OpenAI-compatible (e.g. deepseek → openai)", async () => {
    invalidateProviderConfigCache("ws-3", "my-deepseek");
    (prisma.modelProvider.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { provider: "my-deepseek", adapter: "deepseek" },
    ]);
    (prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      adapter: "deepseek",
      keyCipher: "cipher",
      enabled: true,
      baseUrl: null,
      config: null,
    });
    const key = await findByokKeyForPiProvider("ws-3", "openai");
    expect(key).toBe("decrypted-key");
  });

  it("skips OpenAI-compatible adapters when nativeOnly is set", async () => {
    invalidateProviderConfigCache("ws-6", "my-deepseek");
    (prisma.modelProvider.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { provider: "my-deepseek", adapter: "deepseek" },
    ]);
    // A usable DeepSeek row: without nativeOnly this resolves to its key.
    (prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      adapter: "deepseek",
      keyCipher: "cipher",
      enabled: true,
      baseUrl: null,
      config: null,
    });
    const key = await findByokKeyForPiProvider("ws-6", "openai", { nativeOnly: true });
    expect(key).toBeNull();
  });

  it("returns null when no BYOK row's adapter maps to the requested provider", async () => {
    (prisma.modelProvider.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { provider: "my-openai", adapter: "openai" },
    ]);
    const key = await findByokKeyForPiProvider("ws-4", "anthropic");
    expect(key).toBeNull();
  });

  it("returns null and does not throw when DB read fails", async () => {
    (prisma.modelProvider.findMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection lost"),
    );
    const key = await findByokKeyForPiProvider("ws-5", "anthropic");
    expect(key).toBeNull();
  });
});

describe("isSystemModelId", () => {
  it("accepts every id the catalog offers", () => {
    const ids = SYSTEM_MODELS.flatMap((s) => s.models.map((m) => m.id));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(isSystemModelId(id)).toBe(true);
    }
  });

  // Callers reject ids this returns false for, so a default that fell out of
  // the catalog would fail every unpinned detector rather than degrade.
  it("accepts the detector screening default", () => {
    expect(isSystemModelId(DETECTOR_SYSTEM_DEFAULT_MODEL_ID)).toBe(true);
  });

  it("rejects a retired or invented id", () => {
    expect(isSystemModelId("claude-retired-1")).toBe(false);
    expect(isSystemModelId("")).toBe(false);
  });
});
