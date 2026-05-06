import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyStateParam = vi.fn();
const storeInstallation = vi.fn();
const fetchMock = vi.fn();

vi.mock("@traceroot/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/slack")>();
  return {
    ...actual,
    installer: {
      stateStore: { verifyStateParam: (...a: unknown[]) => verifyStateParam(...a) },
      installationStore: { storeInstallation: (...a: unknown[]) => storeInstallation(...a) },
    },
  };
});
vi.mock("@/env", () => ({
  env: { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "csec", SLACK_REDIRECT_URI: "http://x/cb" },
}));

global.fetch = fetchMock as any;

describe("GET /api/slack/oauth/callback", () => {
  beforeEach(() => {
    verifyStateParam.mockReset();
    storeInstallation.mockReset();
    fetchMock.mockReset();
  });

  it("redirects with error on missing code/state", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/slack/oauth/callback") as any);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("slack=error&reason=missing_params");
  });

  it("redirects with error on invalid state", async () => {
    verifyStateParam.mockRejectedValue(new Error("bad state"));
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/slack/oauth/callback?code=c&state=s") as any);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("slack=error&reason=invalid_state");
  });

  it("happy path: exchanges code, calls storeInstallation, redirects to slack=connected", async () => {
    verifyStateParam.mockResolvedValue({
      metadata: JSON.stringify({ workspaceId: "ws_1", connectedByUserId: "u_1" }),
    });
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        access_token: "xoxb-tok",
        token_type: "bot",
        bot_user_id: "U1",
        app_id: "A1",
        scope: "chat:write,channels:read",
        team: { id: "T1", name: "Acme" },
        authed_user: { id: "U_user" },
      }),
    });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/slack/oauth/callback?code=c&state=s") as any);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "/workspaces/ws_1/settings/integrations?slack=connected",
    );
    expect(storeInstallation).toHaveBeenCalledTimes(1);
    const inst = storeInstallation.mock.calls[0][0];
    expect(inst.team).toEqual({ id: "T1", name: "Acme" });
    expect(inst.bot.token).toBe("xoxb-tok");
    expect(JSON.parse(inst.metadata).workspaceId).toBe("ws_1");
  });

  it("redirects with reason from slack on oauth.v2.access failure", async () => {
    verifyStateParam.mockResolvedValue({
      metadata: JSON.stringify({ workspaceId: "ws_1" }),
    });
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: false, error: "invalid_code" }),
    });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/slack/oauth/callback?code=c&state=s") as any);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("slack=error&reason=exchange_failed");
  });
});
