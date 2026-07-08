// All vi.mock() calls are hoisted by Vitest before imports — keep them at the
// top and self-contained (no out-of-scope variable references).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_URL: "http://localhost:3000",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: "fake-key",
  },
}));

// NextResponse mock mirrors callback/route.test.ts: redirect() exposes the
// resolved absolute URL via .url, and cookies.set() is a no-op spy.
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data, init) => ({
      status: init?.status ?? 200,
      json: async () => data,
      cookies: { set: vi.fn() },
    })),
    redirect: vi.fn((url) => ({
      status: 307,
      url: url.toString(),
      cookies: { set: vi.fn() },
    })),
  },
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    gitHubInstallation: { upsert: vi.fn(async () => ({})) },
  },
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: vi.fn(async () => ({ user: { id: "u_1" } })),
  requireWorkspaceMembership: vi.fn(async () => ({ membership: { workspaceId: "ws_1" } })),
}));

vi.mock("@traceroot/github", () => ({
  GITHUB_INSTALL_STATE_COOKIE: "github_install_state",
  GITHUB_INSTALLATION_ID_COOKIE: "github_installation_id",
  GITHUB_RETURN_TO_COOKIE: "github_return_to",
  GITHUB_WORKSPACE_ID_COOKIE: "github_workspace_id",
  getInstallation: vi.fn(async () => ({ account: { login: "octocat" } })),
}));

import { GET } from "./route";

// Minimal request shape the handler consumes: nextUrl.searchParams + cookies.get
function makeRequest(returnTo: string) {
  const searchParams = new URLSearchParams({
    installation_id: "789",
    state: "state_1",
  });
  const cookies: Record<string, string> = {
    github_install_state: "state_1",
    github_return_to: returnTo,
    github_workspace_id: "ws_1",
  };

  return {
    nextUrl: { searchParams },
    cookies: {
      get: (key: string) => (cookies[key] ? { value: cookies[key] } : undefined),
    },
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /api/github/install-callback", () => {
  it("redirects to a same-origin return path", async () => {
    const res = await GET(makeRequest("/projects/proj_1/settings/github"));

    expect(res.status).toBe(307);
    expect(res.url).toBe("http://localhost:3000/projects/proj_1/settings/github");
  });

  it("falls back to root when returnTo is external", async () => {
    const res = await GET(makeRequest("https://evil.example/phish"));

    expect(res.status).toBe(307);
    expect(res.url).toBe("http://localhost:3000/");
  });
});
