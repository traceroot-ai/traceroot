import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
const env = vi.hoisted(() => ({
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_NAME: "test-app",
  GITHUB_OAUTH_REDIRECT_URI: "http://localhost:3000/api/github/callback",
  BETTER_AUTH_URL: "http://localhost:3000",
}));
vi.mock("@/env", () => ({ env }));
const auth = vi.hoisted(() => ({ requireAuth: vi.fn(), requireWorkspaceMembership: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => auth);

import { GET as login } from "./route";
import { GET as install } from "../install/route";

const RETURN_TO = "/onboarding/connect?projectId=p1";
const request = (path: string) =>
  new NextRequest(
    `http://localhost:3000${path}?workspaceId=ws_1&returnTo=${encodeURIComponent(RETURN_TO)}`,
  );

// The routes build GitHub's URLs from `env`; whether they may start at all is
// read from the process environment. Both are set the same way here.
function setApp(settings: { GITHUB_APP_CLIENT_ID?: string; GITHUB_APP_NAME?: string }) {
  Object.assign(env, settings);
  for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
}

beforeEach(() => {
  setApp({ GITHUB_APP_CLIENT_ID: "Iv1.client", GITHUB_APP_NAME: "test-app" });
  auth.requireAuth.mockResolvedValue({ user: { id: "u_1" } });
  auth.requireWorkspaceMembership.mockResolvedValue({ membership: { role: "ADMIN" } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe.each([
  ["sign-in (/api/github/login)", () => login(request("/api/github/login"))],
  ["installation (/api/github/install)", () => install(request("/api/github/install"))],
])("starting the GitHub %s", (_which, start) => {
  it.each([
    ["the client id", { GITHUB_APP_CLIENT_ID: "" }, "GITHUB_APP_CLIENT_ID"],
    ["the app name", { GITHUB_APP_NAME: "" }, "GITHUB_APP_NAME"],
  ])(
    "without %s, goes back to the starting page saying GitHub is unavailable",
    async (_w, unset, name) => {
      setApp(unset);
      const res = await start();
      const to = new URL(res.headers.get("location")!);

      expect(res.status).toBe(307);
      expect(to.origin).toBe("http://localhost:3000");
      expect(to.pathname).toBe("/onboarding/connect");
      expect(to.searchParams.get("projectId")).toBe("p1");
      expect(to.searchParams.get("github")).toBe("unavailable");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(name));
    },
  );

  it("checks the admin role before saying anything about the setup", async () => {
    setApp({ GITHUB_APP_NAME: "" });
    auth.requireWorkspaceMembership.mockResolvedValue({
      error: new Response(null, { status: 403 }),
    });
    expect((await start()).status).toBe(403);
  });
});

describe("with the GitHub App set up", () => {
  it("sign-in goes to GitHub with the app's client id and this deployment's callback", async () => {
    const res = await login(request("/api/github/login"));
    const to = new URL(res.headers.get("location")!);
    expect(to.host).toBe("github.com");
    expect(to.pathname).toBe("/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("Iv1.client");
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/github/callback");
    expect(to.searchParams.get("state")).toBeTruthy();
  });

  it("installation goes to the app's install page", async () => {
    const res = await install(request("/api/github/install"));
    const to = new URL(res.headers.get("location")!);
    expect(to.host).toBe("github.com");
    expect(to.pathname).toBe("/apps/test-app/installations/new");
  });
});
