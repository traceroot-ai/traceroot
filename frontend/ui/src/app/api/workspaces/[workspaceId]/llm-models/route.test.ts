import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const modelProviderFindManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
  SYSTEM_MODELS: [
    {
      provider: "Anthropic",
      envVar: "ANTHROPIC_API_KEY",
      piAIProvider: "anthropic",
      models: [{ id: "claude-4", label: "Claude 4" }],
    },
  ],
  ADAPTER_MODELS: {
    openai: [{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" }],
  },
  prisma: {
    modelProvider: {
      findMany: (...args: unknown[]) => modelProviderFindManyMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { GET } from "./route";

function makeParams() {
  return { params: Promise.resolve({ workspaceId: "workspace-1" }) };
}

beforeEach(() => {
  modelProviderFindManyMock.mockReset();
  requireAuthMock.mockReset();
  requireWorkspaceMembershipMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "MEMBER" } });
});

describe("GET .../llm-models", () => {
  it("requests BYOK providers in the stable order used by detector defaulting", async () => {
    modelProviderFindManyMock.mockResolvedValue([
      {
        adapter: "openai",
        provider: "first-openai",
        customModels: ["gpt-5.4-mini"],
      },
      {
        adapter: "openai",
        provider: "second-openai",
        customModels: ["gpt-5.4-mini"],
      },
    ]);

    const res = await GET({} as Parameters<typeof GET>[0], makeParams());

    expect(res.status).toBe(200);
    expect(modelProviderFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", enabled: true },
      select: {
        adapter: true,
        provider: true,
        customModels: true,
      },
      orderBy: [{ createTime: "asc" }, { id: "asc" }],
    });
    const body = await res.json();
    expect(body.byokProviders.map((provider: { provider: string }) => provider.provider)).toEqual([
      "first-openai",
      "second-openai",
    ]);
  });
});
