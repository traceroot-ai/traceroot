import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const listWorkspaceModelsMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  listWorkspaceModels: (...args: unknown[]) => listWorkspaceModelsMock(...args),
}));

const requireAuthMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));

import { GET } from "./route";

const request = {} as Parameters<typeof GET>[0];
function makeParams(workspaceId = "ws-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

beforeEach(() => {
  listWorkspaceModelsMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockReset();
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "MEMBER" } });
});

describe("GET /api/workspaces/[workspaceId]/llm-models", () => {
  it("returns the auth error before reading any models", async () => {
    const denied = { status: 401, json: async () => ({ error: "Unauthorized" }) };
    requireAuthMock.mockResolvedValue({ error: denied });
    expect(await GET(request, makeParams())).toBe(denied);
    expect(listWorkspaceModelsMock).not.toHaveBeenCalled();
  });

  it("returns the membership error for a non-member", async () => {
    const denied = { status: 403, json: async () => ({ error: "Forbidden" }) };
    requireWorkspaceMembershipMock.mockResolvedValue({ error: denied });
    expect(await GET(request, makeParams())).toBe(denied);
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith("user-1", "ws-1");
    expect(listWorkspaceModelsMock).not.toHaveBeenCalled();
  });

  it("returns the workspace's models as the picker consumes them", async () => {
    const models = { systemModels: [{ provider: "Anthropic" }], byokProviders: [] };
    listWorkspaceModelsMock.mockResolvedValue(models);
    const res = (await GET(request, makeParams("ws-9"))) as {
      status: number;
      json: () => Promise<unknown>;
    };
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(models);
    expect(listWorkspaceModelsMock).toHaveBeenCalledWith("ws-9");
  });
});
