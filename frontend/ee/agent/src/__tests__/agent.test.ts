import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { getOrCreateAgent, type AgentRunnerConfig } from "../agent.js";
import { pendingDecisions } from "../pending-decisions.js";

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

function config(
  sessionId: string,
  tools: AgentTool<any>[],
  systemPrompt = "sp",
): AgentRunnerConfig {
  return {
    sessionId,
    projectId: "p1",
    workspaceId: "w1",
    userId: "u1",
    systemPrompt,
    tools,
  };
}

describe("getOrCreateAgent", () => {
  it("registers a session-bound write policy hook on the agent", async () => {
    const { agent } = await getOrCreateAgent(config("hook-session", [fakeTool("a")]));

    // The hook is bound to THIS session: with an attended channel registered
    // for it, a confirm-class registry write (create_detector) parks instead
    // of resolving — proving both the registry policies and the session id
    // reached the hook.
    const emitted: Array<{ decisionId: string }> = [];
    pendingDecisions.registerChannel("hook-session", {
      userId: "u1",
      emit: (event) => emitted.push(event),
      keepalive: vi.fn(),
    });
    try {
      const context = {
        toolCall: { type: "toolCall", id: "tc-1", name: "create_detector", arguments: {} },
        args: {},
      } as unknown as BeforeToolCallContext;
      let settled = false;
      const result = agent.beforeToolCall!(context).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(pendingDecisions.pendingCount("hook-session")).toBe(1);

      pendingDecisions.decide(emitted[0].decisionId, "hook-session", { action: "create" });
      await expect(result).resolves.toBeUndefined();
    } finally {
      pendingDecisions.releaseSession("hook-session", "test cleanup");
      const channel = pendingDecisions.channelFor("hook-session");
      if (channel) pendingDecisions.unregisterChannel("hook-session", channel);
    }
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

  it("refreshes the system prompt on cached agents so the model never reasons about stale context", async () => {
    // The prompt carries per-request context (current trace/session/project);
    // pi-agent-core reads state.systemPrompt at prompt time, so a cache hit
    // that keeps the constructed-time prompt would have the model reason
    // about one context while its refreshed tools bind to another.
    const first = await getOrCreateAgent(
      config("prompt-session", [fakeTool("a")], "Currently viewing Trace ID: T1"),
    );
    const second = await getOrCreateAgent(
      config("prompt-session", [fakeTool("a")], "Currently viewing Trace ID: T2"),
    );

    expect(second.agent).toBe(first.agent);
    expect(second.agent.state.systemPrompt).toBe("Currently viewing Trace ID: T2");
  });
});
