import { beforeEach, describe, expect, it, vi } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const consentFindMany = vi.fn();
const projectFindMany = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    oauthConsent: { findMany: (...args: unknown[]) => consentFindMany(...args) },
    project: { findMany: (...args: unknown[]) => projectFindMany(...args) },
  },
}));

const requireAuthMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

import { GET } from "./route";

const createdAt = new Date("2026-11-01T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({ user: { id: "u1" } });
  projectFindMany.mockResolvedValue([{ id: "p1", name: "Checkout agent" }]);
});

describe("GET /api/oauth/connections", () => {
  it("says which connected assistants a host vouches for", async () => {
    consentFindMany.mockResolvedValue([
      {
        id: "c1",
        referenceId: "p1",
        scopes: ["mcp:read"],
        createdAt,
        client: {
          name: "Claude",
          clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
          clientDiscoveryId: "cimd",
          redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        },
      },
      {
        id: "c2",
        referenceId: "p1",
        scopes: ["mcp:read"],
        createdAt,
        client: {
          name: null,
          clientId: "dtqJdvfoQNLbmpKFgRIOYloKUtNuLAKd",
          clientDiscoveryId: null,
          redirectUris: ["https://assistant.example.com/callback"],
        },
      },
    ]);

    const response = await (GET as unknown as () => Promise<{ json: () => Promise<unknown> }>)();
    const { connections } = (await response.json()) as {
      connections: { id: string; clientName: string; verifiedHost: string | null }[];
    };

    expect(
      connections.map(({ id, clientName, verifiedHost }) => ({ id, clientName, verifiedHost })),
    ).toEqual([
      { id: "c1", clientName: "Claude", verifiedHost: "claude.ai" },
      { id: "c2", clientName: "assistant.example.com", verifiedHost: null },
    ]);
    expect(consentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1" } }),
    );
  });
});
