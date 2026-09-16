import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
}));

import { POST } from "./route";

const params = Promise.resolve({ projectId: "p1", sessionId: "s1" });

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/projects/[projectId]/ai/sessions/[sessionId]/decisions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requireAuthMock.mockReset();
    requireProjectAccessMock.mockReset();
    requireAuthMock.mockResolvedValue({ user: { id: "u1" } });
    requireProjectAccessMock.mockResolvedValue({
      project: { id: "p1", workspaceId: "ws1", name: "proj" },
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the decision to the agent service with the caller's identity", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await POST(makeRequest({ decisionId: "d1", action: "create" }), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/projects/p1/sessions/s1/decisions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-user-id"]).toBe("u1");
    expect(JSON.parse(String(init.body))).toEqual({ decisionId: "d1", action: "create" });
  });

  it("passes the service's conflict status through untouched", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "already decided" }), { status: 409 }),
    );

    const res = await POST(makeRequest({ decisionId: "d1", action: "skip" }), { params });
    expect(res.status).toBe(409);
  });

  it("passes the service's not-found status through untouched", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unknown" }), { status: 404 }),
    );

    const res = await POST(makeRequest({ decisionId: "gone", action: "create" }), { params });
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated caller before reaching the service", async () => {
    requireAuthMock.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const res = await POST(makeRequest({ decisionId: "d1", action: "create" }), { params });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a caller without project access before reaching the service", async () => {
    requireProjectAccessMock.mockResolvedValue({ error: new Response(null, { status: 404 }) });

    const res = await POST(makeRequest({ decisionId: "d1", action: "create" }), { params });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the decision fields, dropping anything else in the body", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await POST(
      makeRequest({ decisionId: "d1", action: "revise", text: "smaller", extra: "dropped" }),
      { params },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      decisionId: "d1",
      action: "revise",
      text: "smaller",
    });
  });
});
