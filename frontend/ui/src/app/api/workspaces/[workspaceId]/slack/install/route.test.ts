import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuth = vi.fn();
const requireWorkspaceMembership = vi.fn();
const generateInstallUrl = vi.fn();
const findUnique = vi.fn();
const hasEntitlement = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({ requireAuth, requireWorkspaceMembership }));
vi.mock("@traceroot/slack", () => ({
  installer: { generateInstallUrl: (...args: unknown[]) => generateInstallUrl(...args) },
  SLACK_BOT_SCOPES: ["chat:write"],
}));
vi.mock("@traceroot/core", () => ({
  prisma: { workspace: { findUnique: (...a: unknown[]) => findUnique(...a) } },
  hasEntitlement: (...a: unknown[]) => hasEntitlement(...a),
}));
vi.mock("@/env", () => ({ env: { SLACK_REDIRECT_URI: "http://x/api/slack/oauth/callback" } }));

describe("GET /api/workspaces/[workspaceId]/slack/install", () => {
  beforeEach(() => {
    requireAuth.mockReset();
    requireWorkspaceMembership.mockReset();
    generateInstallUrl.mockReset();
    findUnique.mockReset();
    hasEntitlement.mockReset();
  });

  it("403s for non-ADMIN", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Requires ADMIN role or higher" }), {
        status: 403,
      }),
    });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api?returnTo=/foo") as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });
    expect(res.status).toBe(403);
    expect(requireWorkspaceMembership).toHaveBeenCalledWith("u_1", "ws_1", "ADMIN");
  });

  it("redirects to the upgrade page when plan lacks slack-integration", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({ billingPlan: "starter" });
    hasEntitlement.mockReturnValue(false);

    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api?returnTo=/back") as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });

    expect(hasEntitlement).toHaveBeenCalledWith("starter", "slack-integration");
    expect(generateInstallUrl).not.toHaveBeenCalled();
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/workspaces/ws_1/settings/billing");
    expect(location).toContain("upgrade=slack-integration");
  });

  it("redirects to the SDK-generated install URL when entitled", async () => {
    requireAuth.mockResolvedValue({ user: { id: "u_1" } });
    requireWorkspaceMembership.mockResolvedValue({ membership: {} });
    findUnique.mockResolvedValue({ billingPlan: "starter" });
    hasEntitlement.mockReturnValue(true);
    generateInstallUrl.mockResolvedValue("https://slack.com/oauth/v2/authorize?client_id=&state=");

    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api?returnTo=/back") as any, {
      params: Promise.resolve({ workspaceId: "ws_1" }),
    });

    expect(hasEntitlement).toHaveBeenCalledWith("starter", "slack-integration");
    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get("location")).toContain("slack.com/oauth/v2/authorize");
    expect(generateInstallUrl).toHaveBeenCalledTimes(1);
    const opts = generateInstallUrl.mock.calls[0][0];
    expect(opts.scopes).toEqual(["chat:write"]);
    expect(opts.redirectUri).toBe("http://x/api/slack/oauth/callback");
    const meta = JSON.parse(opts.metadata);
    expect(meta.workspaceId).toBe("ws_1");
    expect(meta.connectedByUserId).toBe("u_1");
    expect(meta.returnTo).toBe("/back");
  });
});
