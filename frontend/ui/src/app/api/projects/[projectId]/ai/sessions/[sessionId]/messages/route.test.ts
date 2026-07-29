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

vi.mock("@traceroot/core", () => ({
  ModelSource: { BYOK: "byok", SYSTEM: "system" },
  PlanType: { FREE: "FREE" },
  isBillingEnabled: () => false,
  prisma: {
    modelProvider: { findFirst: vi.fn().mockResolvedValue(null) },
    workspace: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { POST } from "./route";

function makeParams(sessionId = "sess-1") {
  return { params: Promise.resolve({ projectId: "proj-1", sessionId }) };
}

function makeRequest(body: unknown = { message: "hello", model: "gpt-5", source: "system" }) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  fetchMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
});

describe("POST .../ai/sessions/[sessionId]/messages — role gate", () => {
  it("returns 403 for VIEWER (requires MEMBER)", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Requires MEMBER role or higher" }) },
    });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "MEMBER");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows MEMBER to post a message", async () => {
    requireProjectAccessMock.mockResolvedValue({
      project: { id: "proj-1", workspaceId: "ws-1" },
    });
    const mockStream = new ReadableStream();
    fetchMock.mockResolvedValue({ ok: true, body: mockStream });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });
});
