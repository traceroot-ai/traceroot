import { describe, expect, it } from "vitest";
import { ADAPTER_CONFIG, LLMAdapter } from "@traceroot/core";

import { INTEGRATION_GROUPS, INTEGRATIONS } from "./integrations";

describe("GettingStarted integrations", () => {
  it("includes OpenRouter with dark logo and OpenAI-compatible snippets", () => {
    const openrouter = INTEGRATIONS.find((integration) => integration.id === "openrouter");

    expect(openrouter).toMatchObject({
      name: "OpenRouter",
      href: "https://traceroot.ai/docs/integrations/openrouter",
      category: "provider",
      logo: "/logo/integrations/openrouter.svg",
      logoDark: "/logo/integrations/openrouter-dark.svg",
    });
    expect(openrouter?.languages.python?.installCommand).toBe("pip install traceroot openai");
    expect(openrouter?.languages.python?.initSnippet).toContain(
      'base_url="https://openrouter.ai/api/v1"',
    );
    expect(openrouter?.languages.python?.initSnippet).toContain("Integration.OPENAI");
    expect(openrouter?.languages.typescript?.installCommand).toBe(
      "npm install @traceroot-ai/traceroot openai",
    );
    expect(openrouter?.languages.typescript?.initSnippet).toContain(
      'baseURL: "https://openrouter.ai/api/v1"',
    );
  });

  it("includes OpenCode with dark logo and plugin installation snippets", () => {
    const opencode = INTEGRATIONS.find((integration) => integration.id === "opencode");

    expect(opencode).toMatchObject({
      name: "OpenCode",
      href: "https://traceroot.ai/docs/integrations/opencode",
      category: "framework",
      logo: "/logo/integrations/opencode.svg",
      logoDark: "/logo/integrations/opencode-dark.svg",
    });
    expect(opencode?.languages.typescript?.installCommand).toBe(
      "opencode plugin add @traceroot-ai/opencode-plugin",
    );
    expect(opencode?.languages.typescript?.initSnippet).toContain(
      '"$schema": "https://opencode.ai/config.json"',
    );
    expect(opencode?.languages.typescript?.initSnippet).toContain('"plugins":');
    expect(opencode?.languages.typescript?.initSnippet).toContain("@traceroot-ai/opencode-plugin");
    expect(() => JSON.parse(opencode!.languages.typescript!.initSnippet)).not.toThrow();
  });
});

describe("the two groups the picker offers", () => {
  it("names them in the order the picker shows them", () => {
    expect(INTEGRATION_GROUPS.map((group) => group.category)).toEqual(["provider", "framework"]);
    expect(INTEGRATION_GROUPS.map((group) => group.label)).toEqual([
      "Model providers",
      "Frameworks & SDKs",
    ]);
  });

  it("puts every entry in exactly one group, and leaves neither group empty", () => {
    const categories = INTEGRATION_GROUPS.map((group) => group.category);
    for (const category of categories) {
      expect(INTEGRATIONS.filter((i) => i.category === category).length).toBeGreaterThan(0);
    }
    // Nothing falls outside the two, so the picker's grouped render is the
    // whole catalogue rather than most of it.
    const grouped = categories.flatMap((category) =>
      INTEGRATIONS.filter((i) => i.category === category),
    );
    expect(grouped).toHaveLength(INTEGRATIONS.length);
  });
});

describe("the provider key each integration asks for", () => {
  it("binds a provider's own SDK to that provider's key, with no way to switch", () => {
    // These entries are the provider, or the provider's own agent SDK. A key
    // for anything else would not authenticate the calls being traced.
    const fixed: Record<string, LLMAdapter> = {
      anthropic: LLMAdapter.ANTHROPIC,
      openai: LLMAdapter.OPENAI,
      gemini: LLMAdapter.GOOGLE,
      openrouter: LLMAdapter.OPENROUTER,
      "claude-agent-sdk": LLMAdapter.ANTHROPIC,
      "openai-agents-sdk": LLMAdapter.OPENAI,
      "google-adk": LLMAdapter.GOOGLE,
    };
    for (const [id, adapter] of Object.entries(fixed)) {
      const integration = INTEGRATIONS.find((candidate) => candidate.id === id);
      expect(integration?.providerKey, id).toEqual({ kind: "fixed", adapter });
    }
  });

  it("suggests the provider our own example calls for a framework that takes any", () => {
    // Each of these is derived from the integration's code example rather than
    // its name: LangChain's docs page builds ChatOpenAI, Mastra's builds
    // anthropic("claude-haiku-4-5-..."), DeepAgents' names claude-sonnet-4-6.
    const suggested: Record<string, LLMAdapter> = {
      langchain: LLMAdapter.OPENAI,
      crewai: LLMAdapter.OPENAI,
      autogen: LLMAdapter.OPENAI,
      dspy: LLMAdapter.OPENAI,
      llamaindex: LLMAdapter.OPENAI,
      "microsoft-agent-framework": LLMAdapter.OPENAI,
      pi: LLMAdapter.OPENAI,
      "pydantic-ai": LLMAdapter.OPENAI,
      "vercel-ai": LLMAdapter.OPENAI,
      agno: LLMAdapter.ANTHROPIC,
      mastra: LLMAdapter.ANTHROPIC,
      "langchain-deepagents": LLMAdapter.ANTHROPIC,
    };
    for (const [id, adapter] of Object.entries(suggested)) {
      const integration = INTEGRATIONS.find((candidate) => candidate.id === id);
      expect(integration?.providerKey, id).toEqual({ kind: "suggested", adapter });
    }
  });

  it("says outright that Mistral has no adapter rather than naming a wrong one", () => {
    // The Mistral page is MISTRAL_API_KEY and mistral-large-latest throughout,
    // and LLMAdapter has no Mistral entry — so there is no key this step could
    // store for it. Binding it to some other provider's key would be a lie the
    // field label would then repeat.
    const mistral = INTEGRATIONS.find((integration) => integration.id === "mistral");
    expect(mistral?.providerKey).toEqual({ kind: "none", provider: "Mistral" });
    expect(Object.values(LLMAdapter)).not.toContain("mistral");
  });

  it("gives every entry a binding, and every named adapter a real config", () => {
    for (const integration of INTEGRATIONS) {
      const binding = integration.providerKey;
      expect(binding, integration.id).toBeDefined();
      if (binding.kind === "none") {
        expect(binding.provider, integration.id).not.toBe("");
      } else {
        // The label is what the field is named for, so an adapter with no
        // config entry would render "undefined API key".
        expect(ADAPTER_CONFIG[binding.adapter]?.label, integration.id).toBeTruthy();
      }
    }
  });
});
