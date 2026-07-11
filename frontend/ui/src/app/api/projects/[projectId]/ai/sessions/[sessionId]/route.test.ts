import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { DELETE } from "./route";

function makeParams(sessionId = "sess-1") {
  return { params: Promise.resolve({ projectId: "proj-1", sessionId }) };
}

function makeRequest() {
  return {} as unknown as Parameters<typeof DELETE>[0];
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  fetchMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
});

describe("DELETE .../ai/sessions/[sessionId] — role gate", () => {
  it("returns 403 for VIEWER (requires ADMIN)", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Requires ADMIN role or higher" }) },
    });
    const res = await DELETE(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "ADMIN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows ADMIN to delete a session", async () => {
    requireProjectAccessMock.mockResolvedValue({
      project: { id: "proj-1", workspaceId: "ws-1" },
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    const res = await DELETE(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });
});
