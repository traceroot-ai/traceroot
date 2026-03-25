// All vi.mock() calls are hoisted by Vitest before imports — keep them at the top.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_URL: "http://localhost:3000",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_CLIENT_ID: "client_id",
    GITHUB_APP_CLIENT_SECRET: "client_secret",
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
    gitHubConnection: { upsert: vi.fn() },
  },
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: vi.fn(async () => ({ user: { id: "user_abc" } })),
}));

vi.mock("@traceroot/github", async (importOriginal) => {
  // Keep real validateCallbackParams / verifyInstallationId
  const original = await importOriginal<typeof import("@traceroot/github")>();
  return { ...original };
});

import { POST } from "./route";

// Request helper — constructs a minimal object with the exact shape route.ts
// consumes: headers.get(), json(), cookies.get()
function makeRequest(
  origin: string | null,
  body: object | null = { code: "good-code", installationId: "789" },
  cookies: Record<string, string> = {}
) {
  return {
    method: "POST",
    headers: {
      get: (key: string) => (key === "origin" ? origin : null),
    },
    json: async () => body,
    cookies: {
      get: (key: string) =>
        cookies[key] ? { value: cookies[key] } : undefined,
    },
  } as any;
}

// Sequence-aware fetch stub.
//  - Call #1: GitHub token exchange → { access_token }
//  - Call #2: GitHub /user            → { id, login }
//  - Call #3: GitHub /user/installations → { installations }

function stubFetch({
  accessToken = "ghp_mock",
  userId = 42,
  login = "octocat",
  installations = [{ id: 789, app_id: 123456 }],
  tokenOk = true,
  userOk = true,
  installOk = true,
} = {}) {
  let callCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      callCount++;
      if (callCount === 1)
        return { ok: tokenOk, json: async () => ({ access_token: accessToken }) };
      if (callCount === 2)
        return { ok: userOk, json: async () => ({ id: userId, login }) };
      return { ok: installOk, json: async () => ({ installations }) };
    })
  );
}

describe("POST /api/github/callback (direct install confirmation)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  //Origin header validation
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
  });

  // Request body validation
  describe("Request body validation", () => {
    it("returns 400 when code is missing from body", async () => {
      stubFetch();
      const req = makeRequest("http://localhost:3000", { installationId: "789" });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Missing code parameter" });
    });
  });

  // Successful flow
  describe("Successful flow", () => {
    it("returns 200 with redirectUrl when Origin, code, and auth are valid", async () => {
      stubFetch();
      const req = makeRequest(
        "http://localhost:3000",
        { code: "valid-code", installationId: "789" },
        { "github-return-to": "/" }
      );
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Route returns { sucess: true, redirectUrl: "..." } (note: typo in route.ts is intentional)
      expect(body).toHaveProperty("redirectUrl");
    });

    it("returns 500 when GitHub token exchange fails", async () => {
      stubFetch({ tokenOk: false, accessToken: "" });
      const req = makeRequest(
        "http://localhost:3000",
        { code: "bad-code", installationId: "789" },
        {}
      );
      const res = await POST(req);
      expect(res.status).toBe(500);
    });
  });
});
