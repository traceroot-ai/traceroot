import { describe, expect, it, vi } from "vitest";

const requireAuth = vi.fn();
const requireWorkspaceMembership = vi.fn();
const update = vi.fn();
const info = vi.fn();
const findUnique = vi.fn();
const getClientForTeam = vi.fn(async () => ({ conversations: { info } }));

vi.mock("@/lib/auth-helpers", () => ({ requireAuth, requireWorkspaceMembership }));
vi.mock("@traceroot/core", () => ({
  prisma: { slackIntegration: { update, findUnique } },
}));
vi.mock("@traceroot/slack", () => ({ getClientForTeam }));

describe("POST /api/workspaces/[workspaceId]/slack/channel", () => {
  it("403s for non-ADMIN", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "..." }), { status: 403 }),
    });
    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ channelId: "C1", channelName: "ops" }),
      }) as any,
      { params: Promise.resolve({ workspaceId: "ws_1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("saves channelId/channelName for ADMIN", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({ teamId: "T1" });
    update.mockResolvedValue({});
    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ channelId: "C1", channelName: "ops" }),
      }) as any,
      { params: Promise.resolve({ workspaceId: "ws_1" }) },
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1" },
      data: { channelId: "C1", channelName: "ops" },
    });
  });

  it("resolves manual #name entry via conversations.info", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({ teamId: "T1" });
    info.mockResolvedValue({ ok: true, channel: { id: "C42", name: "ops" } });
    update.mockResolvedValue({});
    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ channelId: "#ops", channelName: "ops" }),
      }) as any,
      { params: Promise.resolve({ workspaceId: "ws_1" }) },
    );
    expect(res.status).toBe(200);
    expect(info).toHaveBeenCalledWith({ channel: "#ops" });
    expect(update).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1" },
      data: { channelId: "C42", channelName: "ops" },
    });
  });
});
