import { beforeEach, describe, expect, it, vi } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

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
  env: {
    SLACK_CLIENT_ID: "cid",
    SLACK_CLIENT_SECRET: "csec",
    SLACK_REDIRECT_URI: "http://x/cb",
    BETTER_AUTH_URL: "http://localhost:3000",
  },
}));

global.fetch = fetchMock as any;

describe("GET /api/slack/oauth/callback", () => {
  beforeEach(() => {
    verifyStateParam.mockReset();
    storeInstallation.mockReset();
    fetchMock.mockReset();
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
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

  describe("returning to where the installation started", () => {
    const CONNECT = "/onboarding/connect?projectId=proj_1";
    const startedFrom = (returnTo: unknown) =>
      verifyStateParam.mockResolvedValue({
        metadata: JSON.stringify({ workspaceId: "ws_1", connectedByUserId: "u_1", returnTo }),
      });
    const exchangeOk = () =>
      fetchMock.mockResolvedValue({
        json: async () => ({
          ok: true,
          access_token: "xoxb-tok",
          token_type: "bot",
          bot_user_id: "U1",
          app_id: "A1",
          scope: "chat:write",
          team: { id: "T1", name: "Acme" },
          authed_user: { id: "U_user" },
        }),
      });
    const callback = async (query: string) => {
      const { GET } = await import("./route");
      const res = await GET(new Request(`http://x/api/slack/oauth/callback?${query}`) as never);
      expect(res.status).toBe(307);
      return new URL(res.headers.get("location")!);
    };

    it("goes back to the page it started from, keeping that page's query", async () => {
      startedFrom(CONNECT);
      exchangeOk();
      const to = await callback("code=c&state=s");
      expect(to.origin).toBe("http://localhost:3000");
      expect(to.pathname).toBe("/onboarding/connect");
      expect(Object.fromEntries(to.searchParams)).toEqual({
        projectId: "proj_1",
        slack: "connected",
      });
    });

    it("goes back there when the person cancels on Slack", async () => {
      startedFrom(CONNECT);
      const to = await callback("error=access_denied&state=s");
      expect(to.pathname).toBe("/onboarding/connect");
      expect(Object.fromEntries(to.searchParams)).toEqual({
        projectId: "proj_1",
        slack: "error",
        reason: "access_denied",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(storeInstallation).not.toHaveBeenCalled();
    });

    it("goes back there when the exchange fails", async () => {
      startedFrom(CONNECT);
      fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: "invalid_code" }) });
      const to = await callback("code=c&state=s");
      expect(`${to.pathname}${to.search}`).toBe(
        "/onboarding/connect?projectId=proj_1&slack=error&reason=exchange_failed",
      );
    });

    it("goes back there when storing the installation fails", async () => {
      startedFrom(CONNECT);
      exchangeOk();
      storeInstallation.mockRejectedValue(new Error("db down"));
      const to = await callback("code=c&state=s");
      expect(`${to.pathname}${to.search}`).toBe(
        "/onboarding/connect?projectId=proj_1&slack=error&reason=store_failed",
      );
    });

    it("replaces the outcome of an earlier attempt instead of adding a second one", async () => {
      startedFrom(`${CONNECT}&slack=error&reason=access_denied`);
      exchangeOk();
      const to = await callback("code=c&state=s");
      expect(to.searchParams.getAll("slack")).toEqual(["connected"]);
      expect(to.searchParams.has("reason")).toBe(false);
    });

    it("keeps a connection made from settings on settings", async () => {
      startedFrom("/workspaces/ws_1/settings/integrations");
      exchangeOk();
      const to = await callback("code=c&state=s");
      expect(`${to.pathname}${to.search}`).toBe(
        "/workspaces/ws_1/settings/integrations?slack=connected",
      );
    });

    it.each([
      ["another site", "https://evil.example/steal"],
      ["a protocol-relative URL", "//evil.example/steal"],
      ["a backslash trick", "/\\evil.example"],
      ["not a string", 42],
    ])("goes to workspace settings instead of %s", async (_, returnTo) => {
      startedFrom(returnTo);
      exchangeOk();
      const to = await callback("code=c&state=s");
      expect(to.origin).toBe("http://localhost:3000");
      expect(to.pathname).toBe("/workspaces/ws_1/settings/integrations");
    });

    it("does not show a Slack error code that does not look like one", async () => {
      startedFrom(CONNECT);
      const to = await callback(`error=${encodeURIComponent("<b>bad</b>")}&state=s`);
      expect(to.searchParams.get("reason")).toBe("slack_error");
    });

    it("cannot tell where to go back to without a valid state", async () => {
      verifyStateParam.mockRejectedValue(new Error("bad state"));
      const to = await callback("error=access_denied&state=forged");
      expect(`${to.pathname}${to.search}`).toBe("/?slack=error&reason=invalid_state");
    });
  });
});
