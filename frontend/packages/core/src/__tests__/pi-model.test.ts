import { describe, expect, it } from "vitest";
import { resolvePiModel, type ProviderModelConfig } from "../pi-model";

describe("resolvePiModel", () => {
  it("uses openai-responses for system gpt-5.3-codex (Codex / GPT-5.x reasoning path)", () => {
    const m = resolvePiModel("gpt-5.3-codex", null);
    expect(m.api).toBe("openai-responses");
    expect(m.provider).toBe("openai");
    expect(m.id).toBe("gpt-5.3-codex");
  });

  it("uses anthropic-messages for system Claude", () => {
    const m = resolvePiModel("claude-sonnet-4-5", null);
    expect(m.api).toBe("anthropic-messages");
    expect(m.provider).toBe("anthropic");
  });

  it("keys BYOK DeepSeek off adapter protocol (openai-completions on openai provider)", () => {
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

  it("uses adapter-specific default when BYOK model id is missing (not Anthropic fallback)", () => {
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

  it("uses catalog apiProtocol for BYOK OpenAI Codex when modelProtocols is unset", () => {
    const cfg: ProviderModelConfig = {
      adapter: "openai",
      key: "sk-test",
      baseUrl: null,
      config: null,
    };
    const m = resolvePiModel("gpt-5.3-codex", cfg);
    expect(m.api).toBe("openai-responses");
  });

  it("respects per-model modelProtocols override over adapter default", () => {
    const cfg: ProviderModelConfig = {
      adapter: "openai",
      key: "sk-test",
      baseUrl: null,
      config: {
        modelProtocols: { "gpt-5": "openai-responses" },
      },
    };
    const m = resolvePiModel("gpt-5", cfg);
    expect(m.api).toBe("openai-responses");
  });
});
