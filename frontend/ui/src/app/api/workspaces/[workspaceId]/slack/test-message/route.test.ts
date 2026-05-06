import { describe, expect, it, vi } from "vitest";

const requireAuth = vi.fn();
const requireWorkspaceMembership = vi.fn();
const findUnique = vi.fn();
const postMessage = vi.fn();
const getClientForTeam = vi.fn(async () => ({ chat: { postMessage } }));

vi.mock("@/lib/auth-helpers", () => ({ requireAuth, requireWorkspaceMembership }));
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));
vi.mock("@traceroot/core", () => ({
  prisma: {
    slackIntegration: { findUnique },
  },
}));
vi.mock("@traceroot/slack", () => ({ getClientForTeam }));

async function callPOST(workspaceId = "ws_1") {
  const { POST } = await import("./route");
  return POST(new Request("http://x", { method: "POST" }) as any, {
    params: Promise.resolve({ workspaceId }),
  });
}

describe("POST /api/workspaces/[workspaceId]/slack/test-message", () => {
  it("403 for non-ADMIN", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1", email: "u@example.com" } });
    requireWorkspaceMembership.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Requires ADMIN role or higher" }), {
        status: 403,
      }),
    });
    const res = await callPOST();
    expect(res.status).toBe(403);
  });

  it("404 not_connected when no SlackIntegration row exists", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1", email: "u@example.com" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue(null);
    const res = await callPOST();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_connected");
  });

  it("400 no_channel_set when channelId is null", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1", email: "u@example.com" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({
      teamId: "T1",
      teamName: "Acme",
      channelId: null,
      channelName: null,
      botToken: "SHOULD_NEVER_LEAK",
    });
    const res = await callPOST();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("no_channel_set");
  });

  it("happy path — sends Block Kit message and returns ok:true with ts and channel", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1", email: "admin@example.com" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({
      teamId: "T1",
      teamName: "Acme",
      channelId: "C1",
      channelName: "general",
      botToken: "SHOULD_NEVER_LEAK",
    });
    postMessage.mockResolvedValue({ ok: true, ts: "1234.5678", channel: "C1" });
    const res = await callPOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ts).toBe("1234.5678");
    expect(body.channel).toEqual({ id: "C1", name: "general" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C1", text: "Test message from TraceRoot" }),
    );
  });

  it("502 not_in_channel — returns user-readable message", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1", email: "admin@example.com" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({
      teamId: "T1",
      teamName: "Acme",
      channelId: "C1",
      channelName: "general",
      botToken: "SHOULD_NEVER_LEAK",
    });
    const slackErr = Object.assign(new Error("not_in_channel"), {
      data: { error: "not_in_channel" },
    });
    postMessage.mockRejectedValue(slackErr);
    const res = await callPOST();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not_in_channel");
    expect(body.message).toBe(
      "TraceRoot is not in this channel. Invite the app with `/invite @TraceRoot` in the channel and try again.",
    );
  });

  it("bot token is never leaked in the response body", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1", email: "admin@example.com" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({
      teamId: "T1",
      teamName: "Acme",
      channelId: "C1",
      channelName: "general",
      botToken: "SHOULD_NEVER_LEAK",
    });
    postMessage.mockResolvedValue({ ok: true, ts: "9999.0001", channel: "C1" });
    const res = await callPOST();
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("xoxb-");
    expect(serialized).not.toContain("SHOULD_NEVER_LEAK");
  });
});
