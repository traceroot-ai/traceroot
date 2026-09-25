import { describe, expect, it } from "vitest";

import { INTEGRATIONS } from "./integrations";

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

  describe("new provider integrations (issue #1794)", () => {
    it("includes Amazon Bedrock with boto3 and AWS SDK snippets", () => {
      const bedrock = INTEGRATIONS.find((integration) => integration.id === "bedrock");

      expect(bedrock).toMatchObject({
        name: "Amazon Bedrock",
        href: "https://traceroot.ai/docs/integrations/bedrock",
        category: "provider",
        logo: "/logo/integrations/bedrock.svg",
      });
      expect(bedrock?.languages.python?.installCommand).toBe("pip install traceroot boto3");
      expect(bedrock?.languages.python?.initSnippet).toContain("Integration.BEDROCK");
      expect(bedrock?.languages.typescript?.installCommand).toBe(
        "npm install @traceroot-ai/traceroot @aws-sdk/client-bedrock-runtime",
      );
      expect(bedrock?.languages.typescript?.initSnippet).toContain("bedrock: bedrockRuntime");
    });

    it("includes Azure OpenAI with OPENAI integration and AzureOpenAI client", () => {
      const azureOpenAI = INTEGRATIONS.find((integration) => integration.id === "azure-openai");

      expect(azureOpenAI).toMatchObject({
        name: "Azure OpenAI",
        href: "https://traceroot.ai/docs/integrations/azure-openai",
        category: "provider",
        logo: "/logo/integrations/azure-openai.svg",
      });
      expect(azureOpenAI?.languages.python?.installCommand).toBe("pip install traceroot openai");
      expect(azureOpenAI?.languages.python?.initSnippet).toContain("Integration.OPENAI");
      expect(azureOpenAI?.languages.python?.initSnippet).toContain("AzureOpenAI");
      expect(azureOpenAI?.languages.typescript?.installCommand).toBe(
        "npm install @traceroot-ai/traceroot openai",
      );
      expect(azureOpenAI?.languages.typescript?.initSnippet).toContain("AzureOpenAI");
    });

    it("includes Groq with Python-only instrumentation (no TypeScript support)", () => {
      const groq = INTEGRATIONS.find((integration) => integration.id === "groq");

      expect(groq).toMatchObject({
        name: "Groq",
        href: "https://traceroot.ai/docs/integrations/groq",
        category: "provider",
        logo: "/logo/integrations/groq.svg",
      });
      expect(groq?.languages.python?.installCommand).toBe("pip install traceroot groq");
      expect(groq?.languages.python?.initSnippet).toContain("Integration.GROQ");
      // Groq has no TypeScript instrumentation in traceroot-ts (see #1794), so no typescript entry
      expect(groq?.languages.typescript).toBeUndefined();
    });
  });

  it("keeps provider integrations in alphabetical order by display name", () => {
    const providers = INTEGRATIONS.filter((integration) => integration.category === "provider");
    const names = providers.map((p) => p.name);
    const sortedNames = [...names].sort();

    expect(names).toEqual(sortedNames);
  });
});
