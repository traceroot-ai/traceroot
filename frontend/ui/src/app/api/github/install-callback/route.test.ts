import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_URL: "http://localhost:3000",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
  },
}));
const upsert = vi.hoisted(() => vi.fn());
vi.mock("@traceroot/core", () => ({ prisma: { gitHubInstallation: { upsert } } }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "u_1" } }),
  requireWorkspaceMembership: async () => ({ membership: { role: "ADMIN" } }),
}));
vi.mock("@traceroot/github", () => ({
  GITHUB_INSTALL_STATE_COOKIE: "gh_state",
  GITHUB_INSTALLATION_ID_COOKIE: "gh_installation",
  GITHUB_RETURN_TO_COOKIE: "gh_return_to",
  GITHUB_WORKSPACE_ID_COOKIE: "gh_workspace",
  getInstallation: async () => ({ account: { login: "acme" } }),
}));

import { GET } from "./route";

function installed(returnTo: string) {
  const request = new NextRequest(
    "http://localhost:3000/api/github/install-callback?installation_id=42&state=s1",
    {
      headers: {
        cookie: `gh_state=s1; gh_workspace=ws_1; gh_return_to=${encodeURIComponent(returnTo)}`,
      },
    },
  );
  return GET(request);
}

beforeEach(() => upsert.mockReset().mockResolvedValue({}));

describe("GET /api/github/install-callback", () => {
  it("goes back to the page the installation started from, with its query", async () => {
    const response = await installed("/onboarding/connect?projectId=proj_1");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/onboarding/connect?projectId=proj_1",
    );
    expect(upsert).toHaveBeenCalledOnce();
  });

  it.each([
    ["another site", "https://evil.example/steal"],
    ["a protocol-relative URL", "//evil.example/steal"],
  ])("goes home instead of %s", async (_, returnTo) => {
    const response = await installed(returnTo);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
  });
});
