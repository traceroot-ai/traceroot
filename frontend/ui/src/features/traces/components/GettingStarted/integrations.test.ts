import { describe, expect, it } from "vitest";
import { ADAPTER_CONFIG, LLMAdapter } from "@traceroot/core";

import {
  filterIntegrations,
  INTEGRATION_GROUPS,
  INTEGRATIONS,
  type IntegrationCategory,
} from "./integrations";

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
});

describe("the three groups the picker offers", () => {
  it("names them in the order the picker shows them", () => {
    expect(INTEGRATION_GROUPS.map((group) => group.category)).toEqual([
      "provider",
      "sdk",
      "agent-framework",
    ]);
    expect(INTEGRATION_GROUPS.map((group) => group.label)).toEqual([
      "Model providers",
      "SDK integrations",
      "Agent frameworks",
    ]);
  });

  it("puts every entry in exactly one group, and leaves no group empty", () => {
    const groups = new Set(INTEGRATION_GROUPS.map((group) => group.category));
    for (const integration of INTEGRATIONS) {
      expect(groups.has(integration.category)).toBe(true);
    }
    for (const category of groups) {
      expect(filterIntegrations("", category).length).toBeGreaterThan(0);
    }
  });

  it("splits the entries on who owns the agent loop, not on the name", () => {
    // The two names that read as the opposite of where they sit. The Claude
    // Agent SDK is a framework for agents you declare; pi is a finished coding
    // agent you drive from your own control flow, as its snippet shows.
    const byId = (id: string) => INTEGRATIONS.find((integration) => integration.id === id);
    expect(byId("claude-agent-sdk")?.category).toBe("agent-framework");
    expect(byId("pi")?.category).toBe("sdk");
    // Mastra declares agents (`new Agent(...)` out of `@mastra/core/agent`);
    // LlamaIndex is a retrieval pipeline whose example never builds one.
    expect(byId("mastra")?.category).toBe("agent-framework");
    expect(byId("llamaindex")?.category).toBe("sdk");
  });

  it("keeps the whole catalogue reachable from the groups together", () => {
    const grouped = INTEGRATION_GROUPS.flatMap((group) => filterIntegrations("", group.category));
    expect(grouped).toHaveLength(INTEGRATIONS.length);
    expect(filterIntegrations("", "all")).toEqual(INTEGRATIONS);
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

describe("narrowing the catalogue", () => {
  it("matches on the displayed name and on the id", () => {
    expect(filterIntegrations("langgraph").map((i) => i.id)).toEqual(["langchain"]);
    expect(filterIntegrations("deepagents").map((i) => i.id)).toEqual(["langchain-deepagents"]);
    expect(filterIntegrations("vercel-ai").map((i) => i.id)).toEqual(["vercel-ai"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(filterIntegrations("  CrEwAi  ").map((i) => i.id)).toEqual(["crewai"]);
    expect(filterIntegrations("   ")).toEqual(INTEGRATIONS);
  });

  it("applies the group and the search together", () => {
    // "openai" names an entry in two different groups.
    expect(filterIntegrations("openai").map((i) => i.id)).toEqual(["openai-agents-sdk", "openai"]);
    expect(filterIntegrations("openai", "provider").map((i) => i.id)).toEqual(["openai"]);
    expect(filterIntegrations("openai", "agent-framework").map((i) => i.id)).toEqual([
      "openai-agents-sdk",
    ]);
    expect(filterIntegrations("openai", "sdk")).toEqual([]);
  });

  it("comes back empty rather than falling back to everything", () => {
    const nothing: IntegrationCategory | "all" = "all";
    expect(filterIntegrations("not-a-framework", nothing)).toEqual([]);
  });
});
