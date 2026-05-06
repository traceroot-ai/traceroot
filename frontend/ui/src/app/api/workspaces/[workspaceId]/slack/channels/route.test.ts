import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuth = vi.fn();
const requireWorkspaceMembership = vi.fn();
const findUnique = vi.fn();
const list = vi.fn();
const getClientForTeam = vi.fn(async () => ({ conversations: { list } }));

vi.mock("@/lib/auth-helpers", () => ({ requireAuth, requireWorkspaceMembership }));
vi.mock("@traceroot/core", () => ({
  prisma: { slackIntegration: { findUnique } },
}));
vi.mock("@traceroot/slack", () => ({ getClientForTeam }));

describe("GET /api/workspaces/[workspaceId]/slack/channels", () => {
  beforeEach(() => {
    list.mockReset();
    findUnique.mockReset();
  });

  it("returns 404 when no integration", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x") as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });
    expect(res.status).toBe(404);
  });

  it("paginates conversations.list and returns id/name/isPrivate", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({ teamId: "T1" });
    list
      .mockResolvedValueOnce({
        ok: true,
        channels: [{ id: "C1", name: "ops", is_private: false }],
        response_metadata: { next_cursor: "x" },
      })
      .mockResolvedValueOnce({
        ok: true,
        channels: [{ id: "C2", name: "secret", is_private: true }],
        response_metadata: { next_cursor: "" },
      });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x") as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });
    expect(await res.json()).toEqual({
      channels: [
        { id: "C1", name: "ops", isPrivate: false },
        { id: "C2", name: "secret", isPrivate: true },
      ],
      hasPrivateChannelAccess: true,
    });
  });

  it("falls back to public-only on missing_scope and surfaces hint", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({ teamId: "T1" });
    const err: any = new Error("missing_scope");
    err.data = { error: "missing_scope" };
    list.mockRejectedValueOnce(err).mockResolvedValueOnce({
      ok: true,
      channels: [{ id: "C1", name: "ops", is_private: false }],
      response_metadata: { next_cursor: "" },
    });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x") as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });
    const body = await res.json();
    expect(body.hasPrivateChannelAccess).toBe(false);
    expect(body.channels.map((c: any) => c.id)).toEqual(["C1"]);
  });
});
