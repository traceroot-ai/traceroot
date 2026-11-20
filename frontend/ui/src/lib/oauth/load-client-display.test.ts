import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: { oauthClient: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

import { loadOAuthClientDisplay } from "./load-client-display";

beforeEach(() => vi.clearAllMocks());

describe("loadOAuthClientDisplay", () => {
  it("describes a registered client from its row", async () => {
    findUnique.mockResolvedValue({
      clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      name: "Claude",
      clientDiscoveryId: "cimd",
      redirectUris: [],
      disabled: false,
    });
    await expect(
      loadOAuthClientDisplay("https://claude.ai/oauth/mcp-oauth-client-metadata"),
    ).resolves.toEqual({ name: "Claude", verifiedHost: "claude.ai" });
  });

  it("shows nothing for an unknown or disabled client", async () => {
    findUnique.mockResolvedValue(null);
    await expect(loadOAuthClientDisplay("missing")).resolves.toBeNull();
    findUnique.mockResolvedValue({
      clientId: "x",
      name: "X",
      clientDiscoveryId: null,
      redirectUris: [],
      disabled: true,
    });
    await expect(loadOAuthClientDisplay("x")).resolves.toBeNull();
  });

  it("does not look up an absent or oversized client id", async () => {
    await expect(loadOAuthClientDisplay(null)).resolves.toBeNull();
    await expect(loadOAuthClientDisplay("x".repeat(3000))).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
