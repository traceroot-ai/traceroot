import { describe, expect, it, vi } from "vitest";

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
  fetchProviderConfig,
  findByokKeyForPiProvider,
  invalidateProviderConfigCache,
  type ProviderModelConfig,
} from "../model-resolver.js";
import { prisma } from "../lib/prisma.js";

describe("resolvePiModel", () => {
  it("uses anthropic-messages for system Claude", () => {
    const m = resolvePiModel("claude-sonnet-4-5", null);
    expect(m.api).toBe("anthropic-messages");
    expect(m.provider).toBe("anthropic");
  });

  it("uses openai-responses for system gpt-5.3-codex (per-model override)", () => {
    const m = resolvePiModel("gpt-5.3-codex", null);
    expect(m.api).toBe("openai-responses");
    expect(m.provider).toBe("openai");
    expect(m.id).toBe("gpt-5.3-codex");
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

  it("respects per-model modelProtocols override over adapter default", () => {
    const cfg: ProviderModelConfig = {
      adapter: "openai",
      key: "sk-test",
      baseUrl: null,
      config: { modelProtocols: { "gpt-5": "openai-responses" } },
    };
    const m = resolvePiModel("gpt-5", cfg);
    expect(m.api).toBe("openai-responses");
  });

  it("uses catalog apiProtocol for BYOK Codex when no modelProtocols override is set", () => {
    // gpt-5.3-codex has apiProtocol: "openai-responses" in ADAPTER_MODELS.openai;
    // resolver should pick that up before the openai adapter default ("openai-completions").
    const cfg: ProviderModelConfig = {
      adapter: "openai",
      key: "sk-test",
      baseUrl: null,
      config: null,
    };
    const m = resolvePiModel("gpt-5.3-codex", cfg);
    expect(m.api).toBe("openai-responses");
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
