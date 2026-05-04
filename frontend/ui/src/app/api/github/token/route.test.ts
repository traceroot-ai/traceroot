import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/env", () => ({
  env: {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: "fake-key",
    INTERNAL_API_SECRET: "test-secret",
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data, init) => ({
      status: init?.status ?? 200,
      json: async () => data,
    })),
  },
}));

const findManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    gitHubInstallation: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireMembershipMock = vi.fn();
const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireMembershipMock(...args),
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

const getInstallationTokenMock = vi.fn();
vi.mock("@traceroot/github", () => ({
  getInstallationToken: (...args: unknown[]) => getInstallationTokenMock(...args),
}));

import { GET } from "./route";

interface RequestInit {
  workspaceIdHeader?: string | null;
  internalSecret?: boolean;
  workspaceIdQuery?: string | null;
  repo?: string | null;
}

function makeRequest({
  workspaceIdHeader = null,
  internalSecret = false,
  workspaceIdQuery = null,
  repo = null,
}: RequestInit = {}) {
  const headers: Record<string, string> = {};
  if (workspaceIdHeader) headers["x-workspace-id"] = workspaceIdHeader;
  if (internalSecret) headers["X-Internal-Secret"] = "test-secret";

  const params = new URLSearchParams();
  if (workspaceIdQuery) params.set("workspaceId", workspaceIdQuery);
  if (repo) params.set("repo", repo);

  return {
    headers: { get: (k: string) => headers[k] ?? null },
    nextUrl: { searchParams: params },
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  findManyMock.mockReset();
  requireAuthMock.mockReset();
  requireMembershipMock.mockReset();
  verifyInternalSecretMock.mockReset();
  getInstallationTokenMock.mockReset();
  getInstallationTokenMock.mockResolvedValue({
    token: "ghs_x",
    expires_at: "2030-01-01T00:00:00Z",
  });
});

describe("GET /api/github/token", () => {
  describe("auth", () => {
    it("uses internal path when x-workspace-id header + valid secret", async () => {
      verifyInternalSecretMock.mockReturnValue(true);
      findManyMock.mockResolvedValue([{ installationId: "1", accountLogin: "acme" }]);
      const res = await GET(makeRequest({ workspaceIdHeader: "ws_1", internalSecret: true }));
      expect(res.status).toBe(200);
      expect(requireAuthMock).not.toHaveBeenCalled();
      expect(findManyMock).toHaveBeenCalledWith({ where: { workspaceId: "ws_1" } });
    });

    it("falls through to session auth when internal secret is missing/invalid", async () => {
      verifyInternalSecretMock.mockReturnValue(false);
      requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
      requireMembershipMock.mockResolvedValue({ membership: { workspaceId: "ws_1" } });
      findManyMock.mockResolvedValue([{ installationId: "1", accountLogin: "acme" }]);
      const res = await GET(makeRequest({ workspaceIdHeader: "ws_1", workspaceIdQuery: "ws_1" }));
      expect(res.status).toBe(200);
      expect(requireAuthMock).toHaveBeenCalled();
    });

    it("session path returns 401 when not authenticated", async () => {
      requireAuthMock.mockResolvedValue({
        error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
      });
      const res = await GET(makeRequest({ workspaceIdQuery: "ws_1" }));
      expect(res.status).toBe(401);
    });

    it("session path returns 400 without workspaceId query", async () => {
      requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
      const res = await GET(makeRequest({}));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "workspaceId required" });
    });

    it("session path returns 403 when user is not a member", async () => {
      requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
      requireMembershipMock.mockResolvedValue({
        error: { status: 403, json: async () => ({ error: "Not a member of this workspace" }) },
      });
      const res = await GET(makeRequest({ workspaceIdQuery: "ws_1" }));
      expect(res.status).toBe(403);
    });
  });

  describe("installation lookup", () => {
    beforeEach(() => {
      verifyInternalSecretMock.mockReturnValue(true);
    });

    it("returns 404 when workspace has no installations", async () => {
      findManyMock.mockResolvedValue([]);
      const res = await GET(makeRequest({ workspaceIdHeader: "ws_1", internalSecret: true }));
      expect(res.status).toBe(404);
    });

    it("returns the only installation when no repo is specified", async () => {
      findManyMock.mockResolvedValue([{ installationId: "1", accountLogin: "acme" }]);
      const res = await GET(makeRequest({ workspaceIdHeader: "ws_1", internalSecret: true }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installation_id).toBe("1");
      expect(body.github_username).toBe("acme");
      expect(body.token).toBe("ghs_x");
    });

    it("matches installation by repo owner when multiple installs exist", async () => {
      findManyMock.mockResolvedValue([
        { installationId: "1", accountLogin: "acme" },
        { installationId: "2", accountLogin: "acme-labs" },
        { installationId: "3", accountLogin: "personal" },
      ]);
      const res = await GET(
        makeRequest({
          workspaceIdHeader: "ws_1",
          internalSecret: true,
          repo: "acme-labs/api",
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installation_id).toBe("2");
      expect(body.github_username).toBe("acme-labs");
    });

    it("matches case-insensitively on owner", async () => {
      findManyMock.mockResolvedValue([{ installationId: "1", accountLogin: "Acme" }]);
      const res = await GET(
        makeRequest({ workspaceIdHeader: "ws_1", internalSecret: true, repo: "ACME/api" }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).installation_id).toBe("1");
    });

    it("falls back to the first install when repo owner doesn't match any", async () => {
      findManyMock.mockResolvedValue([
        { installationId: "1", accountLogin: "acme" },
        { installationId: "2", accountLogin: "other" },
      ]);
      const res = await GET(
        makeRequest({
          workspaceIdHeader: "ws_1",
          internalSecret: true,
          repo: "stranger/api",
        }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).installation_id).toBe("1");
    });
  });

  it("returns 500 when installation token minting fails", async () => {
    verifyInternalSecretMock.mockReturnValue(true);
    findManyMock.mockResolvedValue([{ installationId: "1", accountLogin: "acme" }]);
    getInstallationTokenMock.mockRejectedValue(new Error("github 500"));
    const res = await GET(makeRequest({ workspaceIdHeader: "ws_1", internalSecret: true }));
    expect(res.status).toBe(500);
  });
});
