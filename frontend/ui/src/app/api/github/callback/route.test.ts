// All vi.mock() calls are hoisted by Vitest before imports — keep them at the top.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_URL: "http://localhost:3000",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_CLIENT_ID: "client_id",
    GITHUB_APP_CLIENT_SECRET: "client_secret",
    GITHUB_APP_PRIVATE_KEY: "fake-key",
  },
}));

// NextResponse mock returns objects that mimic status + json() + cookies.set()
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data, init) => ({
      status: init?.status ?? 200,
      json: async () => data,
      cookies: { set: vi.fn() },
    })),
    redirect: vi.fn((url) => ({
      status: 302,
      url: url.toString(),
      cookies: { set: vi.fn() },
    })),
  },
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspaceMember: { findFirst: vi.fn(async () => ({ workspaceId: "ws_1" })) },
    gitHubInstallation: { upsert: vi.fn(async () => ({})) },
  },
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: vi.fn(async () => ({ user: { id: "user_abc" } })),
}));

vi.mock("@traceroot/github", async (importOriginal) => {
  // Keep real validateCallbackParams / verifyInstallationId; stub network helpers.
  const original = await importOriginal<typeof import("@traceroot/github")>();
  return {
    ...original,
    getInstallation: vi.fn(async () => ({
      id: 789,
      account: { login: "octocat", id: 42, type: "User" },
      app_id: 123456,
    })),
  };
});

import { POST } from "./route";

// Request helper — constructs a minimal object with the exact shape route.ts
// consumes: headers.get(), json(), cookies.get()
function makeRequest(
  origin: string | null,
  body: object | null = { code: "good-code", installationId: "789" },
  cookies: Record<string, string> = {},
) {
  return {
    method: "POST",
    headers: {
      get: (key: string) => (key === "origin" ? origin : null),
    },
    json: async () => body,
    cookies: {
      get: (key: string) => (cookies[key] ? { value: cookies[key] } : undefined),
    },
  } as any;
}

// Sequence-aware fetch stub.
//  - Call #1: GitHub token exchange → { access_token }
//  - Call #2: GitHub /user/installations → { installations }
function stubFetch({
  accessToken = "ghp_mock",
  installations = [{ id: 789, app_id: 123456, account: { login: "octocat" } }],
  tokenOk = true,
  installOk = true,
} = {}) {
  let callCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      callCount++;
      if (callCount === 1)
        return { ok: tokenOk, json: async () => ({ access_token: accessToken }) };
      return { ok: installOk, json: async () => ({ installations }) };
    }),
  );
}

describe("POST /api/github/callback (direct install confirmation)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("Origin header validation", () => {
    it("returns 403 when Origin header is absent", async () => {
      const req = makeRequest(null);
      const res = await POST(req);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Invalid origin" });
    });

    it("returns 403 when Origin is an external domain", async () => {
      const req = makeRequest("https://evil-attacker.com");
      const res = await POST(req);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Invalid origin" });
    });

    it("returns 403 when Origin is a subdomain of the app domain", async () => {
      const req = makeRequest("https://sub.localhost:3000");
      const res = await POST(req);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Invalid origin" });
    });

    it("returns 403 (not 500) when Origin is a malformed URL", async () => {
      const req = makeRequest("not-a-url");
      const res = await POST(req);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Invalid origin" });
    });

    it("returns 403 (not 500) when Origin is a protocol-relative URL", async () => {
      const req = makeRequest("//evil.com");
      const res = await POST(req);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Invalid origin" });
    });
  });

  describe("Request body validation", () => {
    it("returns 400 when code is missing from body", async () => {
      stubFetch();
      const req = makeRequest("http://localhost:3000", { installationId: "789" });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Missing code parameter" });
    });
  });

  describe("Successful flow", () => {
    it("returns 200 with redirectUrl when Origin, code, and auth are valid", async () => {
      stubFetch();
      const req = makeRequest(
        "http://localhost:3000",
        { code: "valid-code", installationId: "789" },
        { github_return_to: "/" },
      );
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("success", true);
      expect(body).toHaveProperty("redirectUrl");
      // Verify the install state cookie is cleared after successful flow
      expect(res.cookies.set).toHaveBeenCalledWith(
        "github_install_state",
        "",
        expect.objectContaining({ maxAge: 0 }),
      );
    });

    it("uses the return-to cookie value in the redirectUrl", async () => {
      stubFetch();
      const req = makeRequest(
        "http://localhost:3000",
        { code: "valid-code", installationId: "789" },
        { github_return_to: "/dashboard/settings" },
      );
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.redirectUrl).toContain("/dashboard/settings");
    });

    it("returns 500 when GitHub token exchange fails", async () => {
      stubFetch({ tokenOk: false, accessToken: "" });
      const req = makeRequest(
        "http://localhost:3000",
        { code: "bad-code", installationId: "789" },
        {},
      );
      const res = await POST(req);
      expect(res.status).toBe(500);
    });
  });
});
