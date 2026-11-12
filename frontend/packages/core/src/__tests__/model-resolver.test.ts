import { afterEach, describe, expect, it, vi } from "vitest";

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
import {
  SYSTEM_MODELS,
  DETECTOR_SYSTEM_DEFAULT_MODEL_ID,
  RCA_SYSTEM_DEFAULT_MODEL_ID,
} from "../llm-providers.ts";
import { prisma } from "../lib/prisma.ts";
import { decryptKey } from "../lib/encryption.ts";

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

  it("falls back to the adapter default for Anthropic BYOK with no model id", () => {
    const cfg: ProviderModelConfig = {
      adapter: "anthropic",
      key: "sk-test",
      baseUrl: null,
      config: null,
    };
    expect(resolvePiModel(undefined, cfg).id).toBe("claude-opus-5-5");
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

  it.each([" ", "\t\n ", "\u00a0"])(
    "returns null for a stored key that is blank (%j), so it never reaches pi-ai",
    async (blank) => {
      invalidateProviderConfigCache("ws-blank", "collector");
      vi.mocked(decryptKey).mockReturnValueOnce(blank);
      (prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        adapter: "anthropic",
        keyCipher: "cipher",
        enabled: true,
        baseUrl: "https://collector.invalid",
        config: { modelProtocols: { "claude-opus-4-8": "openai-completions" } },
      });
      expect(await fetchProviderConfig("ws-blank", "collector")).toBeNull();
    },
  );
});

describe("findByokKeyForPiProvider", () => {
  it("skips a row whose stored key is blank and uses the next matching row", async () => {
    invalidateProviderConfigCache("ws-7", "blank-claude");
    invalidateProviderConfigCache("ws-7", "real-claude");
    (prisma.modelProvider.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { provider: "blank-claude", adapter: "anthropic" },
      { provider: "real-claude", adapter: "anthropic" },
    ]);
    // Keyed by row rather than queued, so a failure here cannot leave mock
    // values behind for the tests that follow.
    const findUnique = prisma.modelProvider.findUnique as ReturnType<typeof vi.fn>;
    findUnique.mockImplementation(
      async (args: { where: { workspaceId_provider: { provider: string } } }) => ({
        adapter: "anthropic",
        keyCipher: args.where.workspaceId_provider.provider,
        enabled: true,
        baseUrl: null,
        config: null,
      }),
    );
    vi.mocked(decryptKey).mockImplementation((cipher) =>
      cipher === "blank-claude" ? " " : "sk-real",
    );
    try {
      expect(await findByokKeyForPiProvider("ws-7", "anthropic")).toBe("sk-real");
    } finally {
      findUnique.mockReset();
      vi.mocked(decryptKey).mockReset().mockReturnValue("decrypted-key");
    }
  });

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

describe("resolvePiModel default (no model id, no BYOK)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the named RCA default, not the first Anthropic catalog entry, when an Anthropic key is set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("OPENAI_API_KEY", "");
    const anthropic = SYSTEM_MODELS.find((s) => s.piAIProvider === "anthropic")!;
    // Guard: the test is only meaningful while the catalog head differs from the default.
    expect(anthropic.models[0].id).not.toBe(RCA_SYSTEM_DEFAULT_MODEL_ID);
    const m = resolvePiModel(undefined, null);
    expect(m.id).toBe(RCA_SYSTEM_DEFAULT_MODEL_ID);
    expect(m.provider).toBe("anthropic");
    expect(m.api).toBe("anthropic-messages");
  });

  it("is a model in the hosted catalog (so it can actually be resolved)", () => {
    expect(isSystemModelId(RCA_SYSTEM_DEFAULT_MODEL_ID)).toBe(true);
  });

  it("falls back to the first model of the first keyed provider when the default's key is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
    const m = resolvePiModel(undefined, null);
    expect(m.provider).toBe("openai");
    expect(m.id).toBe(SYSTEM_MODELS.find((s) => s.piAIProvider === "openai")!.models[0].id);
  });

  it("returns the named default even with no provider key at all", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(resolvePiModel(undefined, null).id).toBe(RCA_SYSTEM_DEFAULT_MODEL_ID);
  });

  it("does not override an explicit model id", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(resolvePiModel("claude-opus-4-8", null).id).toBe("claude-opus-4-8");
  });

  it("does not override a BYOK adapter's own first curated model", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const cfg: ProviderModelConfig = {
      adapter: "deepseek",
      key: "sk-test",
      baseUrl: null,
      config: null,
    };
    expect(resolvePiModel(undefined, cfg).id).toMatch(/^deepseek-/);
  });
});
