import { describe, it, expect, vi, beforeEach } from "vitest";

const clearMock = vi.fn();
const readMock = vi.fn();
vi.mock("@/lib/oauth/project-selection", () => ({
  clearProjectSelection: (...args: unknown[]) => clearMock(...args),
  readProjectSelection: (...args: unknown[]) => readMock(...args),
}));

import { MCP_READ_SCOPE, mcpOAuthProviderOptions } from "./provider-options";

const RESOURCE = "https://mcp.example.com/mcp";
const options = mcpOAuthProviderOptions(RESOURCE);
const session = { id: "sess-1" };

beforeEach(() => {
  clearMock.mockReset();
  readMock.mockReset();
});

describe("mcpOAuthProviderOptions", () => {
  it("grants read access to the MCP server and nothing wider", () => {
    expect(options.scopes).toEqual([MCP_READ_SCOPE, "offline_access"]);
    expect(options.resources.map((r) => r.identifier)).toEqual([RESOURCE]);
    expect(options.clientRegistrationDefaultResources).toEqual([RESOURCE]);
    // A registering client cannot ask for more than the server grants.
    expect(options.clientRegistrationAllowedScopes).toEqual(options.scopes);
  });

  it("registers public clients dynamically", () => {
    expect(options.allowDynamicClientRegistration).toBe(true);
    expect(options.allowUnauthenticatedClientRegistration).toBe(true);
  });

  it("registers a loopback or custom-scheme client as native when it does not say", () => {
    expect(options.clientRegistrationDefaultApplicationType).toBe("infer");
  });

  it("rotates refresh tokens, replaying a lost response for two minutes", () => {
    // Seconds. Registration, authorization and refresh run end to end in
    // provider-flow.integration.test.ts.
    expect(options.refreshTokenReuseInterval).toBe(120);
  });

  describe("the project picker", () => {
    const { shouldRedirect } = options.postLogin;

    it("is shown on the first pass of every authorization, discarding an older choice", async () => {
      readMock.mockResolvedValue("p-old");

      expect(await shouldRedirect({ session, isContinuation: false })).toBe(true);
      expect(clearMock).toHaveBeenCalledWith("sess-1");
    });

    it("lets the user through once a choice is on record", async () => {
      readMock.mockResolvedValue("p1");
      expect(await shouldRedirect({ session, isContinuation: true })).toBe(false);
    });

    it("sends the user back when they continue without having chosen", async () => {
      readMock.mockResolvedValue(null);
      expect(await shouldRedirect({ session, isContinuation: true })).toBe(true);
    });
  });

  describe("while a support employee is impersonating", () => {
    const impersonated = { id: "sess-1", impersonatedBy: "staff-1" };

    it("refuses to start an authorization", async () => {
      await expect(
        options.postLogin.shouldRedirect({ session: impersonated, isContinuation: false }),
      ).rejects.toThrow(/impersonation/i);
    });

    it("refuses to give a consent a project", async () => {
      readMock.mockResolvedValue("p1");
      await expect(options.postLogin.consentReferenceId({ session: impersonated })).rejects.toThrow(
        /impersonation/i,
      );
    });
  });

  describe("the consent reference", () => {
    const { consentReferenceId } = options.postLogin;

    it("is the project the user chose", async () => {
      readMock.mockResolvedValue("p1");
      expect(await consentReferenceId({ session })).toBe("p1");
    });

    it("fails rather than consenting without a project", async () => {
      readMock.mockResolvedValue(null);
      await expect(consentReferenceId({ session })).rejects.toThrow();
    });
  });

  describe("the access token", () => {
    it("carries the chosen project", () => {
      expect(options.customAccessTokenClaims({ referenceId: "p1" })).toEqual({
        project_id: "p1",
      });
    });

    it("carries no project when the consent has none, so the backend refuses it", () => {
      expect(options.customAccessTokenClaims({})).toEqual({});
    });
  });
});
