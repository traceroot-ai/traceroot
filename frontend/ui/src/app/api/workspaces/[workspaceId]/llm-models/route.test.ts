import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modelProviderFindManyMock = vi.fn();
const requireAuthMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
  SYSTEM_MODELS: [
    {
      provider: "Anthropic",
      envVar: "ANTHROPIC_API_KEY",
      piAIProvider: "anthropic",
      apiProtocol: "anthropic-messages",
      models: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
    },
    {
      provider: "OpenAI",
      envVar: "OPENAI_API_KEY",
      piAIProvider: "openai",
      apiProtocol: "openai-responses",
      models: [{ id: "gpt-5.4-mini", label: "GPT 5.4 mini" }],
    },
  ],
  ADAPTER_MODELS: {
    openai: [{ id: "gpt-5.4-mini", label: "GPT 5.4 mini" }],
  },
  prisma: {
    modelProvider: {
      findMany: (...args: unknown[]) => modelProviderFindManyMock(...args),
    },
  },
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  successResponse: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}));

import { GET } from "./route";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalOpenAIKey = process.env.OPENAI_API_KEY;

function restoreEnv() {
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;

  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: "workspace-1" }) };
}

describe("GET /api/workspaces/[workspaceId]/llm-models", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    modelProviderFindManyMock.mockReset();
    requireAuthMock.mockReset();
    requireWorkspaceMembershipMock.mockReset();
    requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
    requireWorkspaceMembershipMock.mockResolvedValue({ membership: { id: "member-1" } });
    modelProviderFindManyMock.mockResolvedValue([]);
  });

  afterEach(() => {
    restoreEnv();
  });

  it("returns canonical system provider keys for configured system providers", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    modelProviderFindManyMock.mockResolvedValue([
      {
        provider: "local-openai",
        adapter: "openai",
        customModels: ["gpt-5.4-mini", "unsupported-local", " "],
      },
    ]);

    const res = await GET(new Request("http://localhost") as never, makeParams());
    const body = await res.json();

    expect(body.systemModels).toEqual([
      {
        provider: "anthropic",
        adapter: "anthropic",
        source: "system",
        models: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
      },
    ]);
    expect(JSON.stringify(body.systemModels)).not.toContain("Anthropic");
    expect(body.byokProviders).toEqual([
      {
        provider: "local-openai",
        adapter: "openai",
        source: "byok",
        models: [
          { id: "gpt-5.4-mini", label: "gpt-5.4-mini", supported: true },
          { id: "unsupported-local", label: "unsupported-local", supported: false },
        ],
      },
    ]);
    expect(modelProviderFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", enabled: true },
      select: { adapter: true, provider: true, customModels: true },
    });
  });

  it("does not return fallback system models when no system provider env var is configured", async () => {
    const res = await GET(new Request("http://localhost") as never, makeParams());
    const body = await res.json();

    expect(body).toEqual({ systemModels: [], byokProviders: [] });
  });
});
