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
    expect(opencode?.languages.typescript?.initSnippet).toContain("@traceroot-ai/opencode-plugin");
  });
});
