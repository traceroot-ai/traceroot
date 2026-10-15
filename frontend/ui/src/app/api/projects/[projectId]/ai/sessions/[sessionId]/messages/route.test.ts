import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

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

const decideDemoChatMock = vi.fn();
vi.mock("@/lib/demo-ai-chat", () => ({
  decideDemoChat: (...args: unknown[]) => decideDemoChatMock(...args),
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
      membership: { workspaceId: "ws1", userId: "u1", role: "VIEWER" },
    });
    decideDemoChatMock.mockReset();
    decideDemoChatMock.mockResolvedValue({ kind: "unrestricted" });
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

  it("forwards exactly the fields the panel can send, window included, and nothing else", async () => {
    // The allowlist is the contract: a field the hook adds and the proxy
    // drops must show up here as a test edit, not as a silent default.
    fetchMock.mockResolvedValue(new Response("data: {}\n\n", { status: 200 }));
    const everything = {
      ...sendBody,
      traceId: "t1",
      traceSessionId: "ts1",
      range: "14d",
      start_time: "2026-09-01T00:00:00.000Z",
      end_time: "2026-09-02T00:00:00.000Z",
      extra: "never forwarded",
    };

    await POST(makeRequest(everything), { params });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const { extra: _extra, ...forwarded } = everything;
    expect(JSON.parse(init.body as string)).toEqual(forwarded);
  });

  it("sends no window keys at all when the panel sent none, so the service falls back", async () => {
    fetchMock.mockResolvedValue(new Response("data: {}\n\n", { status: 200 }));
    await POST(makeRequest(sendBody), { params });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    for (const key of ["range", "start_time", "end_time"]) expect(parsed).not.toHaveProperty(key);
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

  it("asks the demo policy with the caller's workspace, user and role", async () => {
    fetchMock.mockResolvedValue(new Response("data: {}\n\n", { status: 200 }));
    await POST(makeRequest(sendBody), { params });
    expect(decideDemoChatMock).toHaveBeenCalledWith({
      workspaceId: "ws1",
      userId: "u1",
      role: "VIEWER",
    });
  });

  it("returns 429 with the policy's message when the demo daily limit is used up", async () => {
    decideDemoChatMock.mockResolvedValue({
      kind: "blocked",
      status: 429,
      error: "The demo allows 5 AI messages per day.",
    });

    const res = await POST(makeRequest(sendBody), { params });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "The demo allows 5 AI messages per day." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces the requested model with the demo model for a limited visitor", async () => {
    fetchMock.mockResolvedValue(new Response("data: {}\n\n", { status: 200 }));
    decideDemoChatMock.mockResolvedValue({
      kind: "limited",
      choice: { model: "claude-haiku-4-5", providerName: undefined, source: "SYSTEM" },
      remaining: 3,
    });

    await POST(
      makeRequest({
        ...sendBody,
        model: "claude-opus-4-8",
        providerName: "byok-x",
        source: "BYOK",
      }),
      { params },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(init.body as string);
    expect(forwarded.model).toBe("claude-haiku-4-5");
    expect(forwarded.source).toBe("SYSTEM");
    expect(forwarded).not.toHaveProperty("providerName");
  });

  it("rejects an unauthenticated caller before reaching the service", async () => {
    requireAuthMock.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const res = await POST(makeRequest(sendBody), { params });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
