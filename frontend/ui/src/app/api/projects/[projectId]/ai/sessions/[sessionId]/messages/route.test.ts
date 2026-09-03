import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  successResponse: (data: unknown) => Response.json(data),
}));

const workspaceFindUniqueMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    modelProvider: { findFirst: vi.fn() },
    workspace: { findUnique: (...args: unknown[]) => workspaceFindUniqueMock(...args) },
  },
  ModelSource: { BYOK: "BYOK", SYSTEM: "SYSTEM" },
  PlanType: { FREE: "FREE" },
  isBillingEnabled: () => false,
}));

import { POST } from "./route";

const params = Promise.resolve({ projectId: "p1", sessionId: "s1" });

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const sendBody = { message: "hi", model: "m", providerName: "anthropic", source: "SYSTEM" };

describe("POST /api/projects/[projectId]/ai/sessions/[sessionId]/messages", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requireAuthMock.mockReset();
    requireProjectAccessMock.mockReset();
    workspaceFindUniqueMock.mockReset();
    requireAuthMock.mockResolvedValue({ user: { id: "u1" } });
    requireProjectAccessMock.mockResolvedValue({
      project: { id: "p1", workspaceId: "ws1", name: "proj" },
    });
    workspaceFindUniqueMock.mockResolvedValue({ aiBlocked: false, billingPlan: "PRO" });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the service's SSE body through with the caller's identity", async () => {
    fetchMock.mockResolvedValue(
      new Response("event: done\ndata: {}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await POST(makeRequest(sendBody), { params });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await res.text()).toContain("event: done");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/p1/sessions/s1/messages");
    expect((init.headers as Record<string, string>)["x-user-id"]).toBe("u1");
  });

  it("forwards the service's own error text when a run is already in flight", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "a run is already in progress for this session" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await POST(makeRequest(sendBody), { params });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "a run is already in progress for this session" });
  });

  it("falls back to a generic error when the service body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("upstream exploded", { status: 502 }));

    const res = await POST(makeRequest(sendBody), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Agent service error" });
  });

  it("rejects an unauthenticated caller before reaching the service", async () => {
    requireAuthMock.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const res = await POST(makeRequest(sendBody), { params });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
