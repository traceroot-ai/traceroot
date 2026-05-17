import { describe, expect, it, vi } from "vitest";

const requireAuth = vi.fn();
const requireWorkspaceMembership = vi.fn();
const findUnique = vi.fn();
const deleteMany = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({ requireAuth, requireWorkspaceMembership }));
vi.mock("@traceroot/core", () => ({
  prisma: { slackIntegration: { findUnique, deleteMany } },
}));

describe("GET /api/workspaces/[workspaceId]/slack", () => {
  it("returns connected:false when no integration row", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x") as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });
    expect(await res.json()).toEqual({ connected: false });
  });

  it("returns connected status without exposing botToken", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({
      teamName: "Acme",
      botUserId: "U1",
      channelId: "C1",
      channelName: "ops",
      botToken: "SHOULD_NEVER_LEAK",
    });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x") as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });
    const body = await res.json();
    expect(body).toEqual({
      connected: true,
      teamName: "Acme",
      botUserId: "U1",
      channel: { id: "C1", name: "ops" },
    });
    expect(JSON.stringify(body)).not.toContain("SHOULD_NEVER_LEAK");
  });
});

describe("DELETE /api/workspaces/[workspaceId]/slack", () => {
  it("403s for non-ADMIN", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Requires ADMIN role or higher" }), {
        status: 403,
      }),
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(new Request("http://x", { method: "DELETE" }) as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });
    expect(res.status).toBe(403);
  });

  it("deletes the integration row when ADMIN", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    deleteMany.mockResolvedValue({ count: 1 });
    const { DELETE } = await import("./route");
    const res = await DELETE(new Request("http://x", { method: "DELETE" }) as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });
    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws_1" } });
  });
});
