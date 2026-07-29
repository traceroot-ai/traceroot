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

import { POST } from "./route";

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1" }) };
}

function makeRequest(body: unknown = {}) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  fetchMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
});

describe("POST .../ai/sessions — role gate", () => {
  it("returns 403 for VIEWER (requires MEMBER)", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Requires MEMBER role or higher" }) },
    });
    const res = await POST(makeRequest({ title: "new session" }), makeParams());
    expect(res.status).toBe(403);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "MEMBER");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows MEMBER to create a session", async () => {
    requireProjectAccessMock.mockResolvedValue({
      project: { id: "proj-1", workspaceId: "ws-1" },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "sess-1" }),
    });
    const res = await POST(makeRequest({ title: "new session" }), makeParams());
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalled();
  });
});
