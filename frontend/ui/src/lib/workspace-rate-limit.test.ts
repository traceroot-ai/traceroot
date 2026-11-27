import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isBillingEnabled: vi.fn(),
  workspace: { findUnique: vi.fn() },
  fetch: vi.fn(),
}));
vi.mock("@traceroot/core", () => ({
  isBillingEnabled: mocks.isBillingEnabled,
  prisma: { workspace: mocks.workspace },
}));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "server-secret" } }));

import { withWorkspaceRateLimit } from "./workspace-rate-limit";

const budgetHeaders = {
  "x-ratelimit-limit": "30",
  "x-ratelimit-remaining": "29",
  "x-ratelimit-reset": "1800000000",
  "retry-after": "12",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isBillingEnabled.mockReturnValue(true);
  mocks.workspace.findUnique.mockResolvedValue({ billingPlan: "pro" });
  mocks.fetch.mockResolvedValue(new Response(null, { status: 204, headers: budgetHeaders }));
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("withWorkspaceRateLimit", () => {
  it("charges the server-resolved workspace plan and passes through real budget headers", async () => {
    const operation = vi.fn(async () => Response.json({ success: true }));
    const response = await withWorkspaceRateLimit("ws-1", operation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(operation).toHaveBeenCalledOnce();
    expect(mocks.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      select: { billingPlan: true },
    });
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/internal\/rate-limit$/);
    expect(JSON.parse(init.body)).toEqual({ workspaceId: "ws-1", billingPlan: "pro" });
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Internal-Secret": "server-secret",
    });
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    for (const [name, value] of Object.entries(budgetHeaders)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it("does not execute an operation when its budget is exhausted", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { ...budgetHeaders, "x-ratelimit-remaining": "0", "set-cookie": "secret" },
      }),
    );
    const operation = vi.fn();
    const response = await withWorkspaceRateLimit("ws-1", operation);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Rate limit exceeded" });
    expect(response.headers.get("retry-after")).toBe("12");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([200, 401, 403, 500, 503])(
    "fails closed on an unexpected limiter status %s",
    async (status) => {
      mocks.fetch.mockResolvedValue(new Response(null, { status }));
      const operation = vi.fn();
      const response = await withWorkspaceRateLimit("ws-1", operation);
      expect(response.status).toBe(503);
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it("fails closed on a network failure", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection refused"));
    const operation = vi.fn();
    const response = await withWorkspaceRateLimit("ws-1", operation);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Unable to check request limit" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed when the workspace plan lookup is unavailable", async () => {
    mocks.workspace.findUnique.mockRejectedValue(new Error("database unavailable"));
    const operation = vi.fn();
    const response = await withWorkspaceRateLimit("ws-1", operation);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Unable to check request limit" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not fall back to a free bucket for a missing workspace", async () => {
    mocks.workspace.findUnique.mockResolvedValue(null);
    const operation = vi.fn();
    expect((await withWorkspaceRateLimit("missing", operation)).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it("uses the existing free default when the stored plan is null", async () => {
    mocks.workspace.findUnique.mockResolvedValue({ billingPlan: null });
    await withWorkspaceRateLimit("ws-1", async () => new Response());
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({
      workspaceId: "ws-1",
      billingPlan: "free",
    });
  });

  it("preserves self-host behavior without requiring a REST rate-limit service", async () => {
    mocks.isBillingEnabled.mockReturnValue(false);
    const expected = Response.json({ success: true });
    expect(await withWorkspaceRateLimit("ws-1", async () => expected)).toBe(expected);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.workspace.findUnique).not.toHaveBeenCalled();
  });
});
