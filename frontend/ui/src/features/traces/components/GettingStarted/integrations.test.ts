import { describe, expect, it } from "vitest";

import { ADAPTER_DEFAULT_BASE_URL } from "@traceroot/core/llm-providers";

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

  // xAI, Moonshot and Z.AI are OpenAI-compatible and have no dedicated SDK
  // Integration value, so they are instrumented the same way OpenRouter is:
  // Integration.OPENAI plus the provider's base URL. The base URLs are asserted
  // against ADAPTER_DEFAULT_BASE_URL so a change there cannot silently leave the
  // onboarding snippets pointing at a stale endpoint.
  it.each([
    { id: "xai", name: "xAI", adapter: "xai", envVar: "XAI_API_KEY" },
    { id: "moonshot", name: "Moonshot (Kimi)", adapter: "moonshot", envVar: "MOONSHOT_API_KEY" },
    { id: "zai", name: "Z.AI (GLM)", adapter: "zai", envVar: "ZAI_API_KEY" },
  ])(
    "includes $name as an OpenAI-compatible provider pointed at its own base URL",
    ({ id, name, adapter, envVar }) => {
      const integration = INTEGRATIONS.find((entry) => entry.id === id);
      const baseUrl = ADAPTER_DEFAULT_BASE_URL[adapter];

      expect(baseUrl).toBeTruthy();
      expect(integration).toMatchObject({
        name,
        href: `https://traceroot.ai/docs/integrations/${id}`,
        category: "provider",
        logo: `/logo/integrations/${id}.svg`,
      });

      expect(integration?.languages.python?.installCommand).toBe("pip install traceroot openai");
      expect(integration?.languages.python?.initSnippet).toContain("Integration.OPENAI");
      expect(integration?.languages.python?.initSnippet).toContain(`base_url="${baseUrl}"`);
      expect(integration?.languages.python?.initSnippet).toContain(`os.environ["${envVar}"]`);

      expect(integration?.languages.typescript?.installCommand).toBe(
        "npm install @traceroot-ai/traceroot openai",
      );
      expect(integration?.languages.typescript?.initSnippet).toContain(`baseURL: "${baseUrl}"`);
      expect(integration?.languages.typescript?.initSnippet).toContain(`process.env.${envVar}`);
    },
  );

  // The xAI mark is a bare black glyph with no background, so without a dark
  // variant it disappears against a dark card. Moonshot and Z.AI ship their own
  // background rects and need none. The general dark-logo gap is tracked in #1555.
  it("gives xAI a dark logo variant", () => {
    const xai = INTEGRATIONS.find((entry) => entry.id === "xai");

    expect(xai?.logoDark).toBe("/logo/integrations/xai-dark.svg");
  });
});
