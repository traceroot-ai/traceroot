import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getOrCreateAgent, type AgentRunnerConfig } from "../agent.js";
import { writePolicyHook } from "../tools/write-policy.js";

// Keep the module graph off Prisma and the DB: the agent cache logic under
// test only needs a context-loading stub and a resolvable model.
vi.mock("@traceroot/core", () => ({
  ADAPTER_TO_PI_AI: {},
  BEDROCK_USE_DEFAULT_CREDENTIALS: "__bedrock_default__",
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));
vi.mock("@traceroot/core/model-resolver", () => ({
  resolvePiModel: vi.fn(() => ({ id: "test-model", provider: "anthropic" })),
  fetchProviderConfig: vi.fn(async () => null),
  findByokKeyForPiProvider: vi.fn(async () => null),
  invalidateProviderConfigCache: vi.fn(),
}));
vi.mock("../session.js", () => ({
  SessionManager: vi.fn(() => ({ buildContext: vi.fn(async () => []) })),
}));

function fakeTool(name: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({ content: [], details: undefined }),
  } as unknown as AgentTool<any>;
}

function config(sessionId: string, tools: AgentTool<any>[]): AgentRunnerConfig {
  return {
    sessionId,
    projectId: "p1",
    workspaceId: "w1",
    userId: "u1",
    systemPrompt: "sp",
    tools,
  };
}

describe("getOrCreateAgent", () => {
  it("registers the fail-closed write policy hook on the agent", async () => {
    const { agent } = await getOrCreateAgent(config("hook-session", [fakeTool("a")]));
    expect(agent.beforeToolCall).toBe(writePolicyHook);
  });

  it("refreshes tool closures on cached agents so per-request context never goes stale", async () => {
    const first = await getOrCreateAgent(config("cache-session", [fakeTool("stale")]));
    const second = await getOrCreateAgent(config("cache-session", [fakeTool("fresh")]));

    // Same cached agent (same session, same model)...
    expect(second.agent).toBe(first.agent);
    // ...but the tools must be this request's closures, not the first's:
    // write tools close over projectId, and the session cache outlives a
    // project switch, so stale closures would write into the wrong project.
    expect(second.agent.state.tools.map((t) => t.name)).toEqual(["fresh"]);
  });
});
