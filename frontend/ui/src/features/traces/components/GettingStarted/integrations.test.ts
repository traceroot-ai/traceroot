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

  it("includes LiveKit Agents with dark logo, Python and TypeScript snippets", () => {
    const livekit = INTEGRATIONS.find((integration) => integration.id === "livekit");

    expect(livekit).toMatchObject({
      name: "LiveKit Agents",
      href: "https://traceroot.ai/docs/integrations/livekit",
      category: "framework",
      logo: "/logo/integrations/livekit.svg",
      logoDark: "/logo/integrations/livekit-dark.svg",
    });
    expect(livekit?.languages.python?.installCommand).toBe("pip install traceroot livekit-agents");
    expect(livekit?.languages.python?.initSnippet).toContain("Integration.LIVEKIT");
    expect(livekit?.languages.typescript?.installCommand).toBe(
      "npm install @traceroot-ai/traceroot @livekit/agents",
    );
    expect(livekit?.languages.typescript?.initSnippet).toContain("livekitAgents");
  });
});
