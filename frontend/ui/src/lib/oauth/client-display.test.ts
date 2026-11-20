import { describe, expect, it, vi } from "vitest";

// provider-options pulls in the database through project-selection; only its
// page constant is compared here.
vi.mock("@traceroot/core", () => ({ prisma: {} }));

import {
  CONTINUE_PATH,
  clientIdFromCallbackUrl,
  describeOAuthClient,
  describeRedirectTarget,
  metadataDocumentHost,
  workspaceSuffix,
} from "./client-display";
import { OAUTH_CONTINUE_PAGE } from "./provider-options";

const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";

describe("metadataDocumentHost", () => {
  it("vouches for a metadata-document client by the host serving its document", () => {
    expect(metadataDocumentHost(CLAUDE, "cimd")).toBe("claude.ai");
  });

  it("vouches for nothing a client registered itself", () => {
    expect(metadataDocumentHost("dtqJdvfoQNLbmpKFgRIOYloKUtNuLAKd", null)).toBeNull();
  });

  it("needs both the discovery mark and an HTTPS client_id", () => {
    expect(metadataDocumentHost(CLAUDE, null)).toBeNull();
    expect(metadataDocumentHost("http://claude.ai/doc", "cimd")).toBeNull();
    expect(metadataDocumentHost("not a url", "cimd")).toBeNull();
  });
});

describe("describeOAuthClient", () => {
  it("uses the published name and host for a metadata-document client", () => {
    expect(
      describeOAuthClient({ clientId: CLAUDE, name: "Claude", clientDiscoveryId: "cimd" }),
    ).toEqual({ name: "Claude", verifiedHost: "claude.ai" });
  });

  it("falls back to the redirect host for a nameless self-registered client", () => {
    expect(
      describeOAuthClient({
        clientId: "abc",
        name: null,
        clientDiscoveryId: null,
        redirectUris: ["https://assistant.example.com/callback"],
      }),
    ).toEqual({ name: "assistant.example.com", verifiedHost: null });
  });

  it("says when there is nothing to name a client by", () => {
    expect(describeOAuthClient({ clientId: "abc", name: " ", clientDiscoveryId: null }).name).toBe(
      "An unnamed application",
    );
  });
});

describe("clientIdFromCallbackUrl", () => {
  it("is the same page the provider sends signed-out users to", () => {
    expect(CONTINUE_PATH).toBe(OAUTH_CONTINUE_PAGE);
  });

  it("reads the client of an authorization waiting on sign-in", () => {
    const callback = `/oauth/continue?response_type=code&client_id=${encodeURIComponent(CLAUDE)}`;
    expect(clientIdFromCallbackUrl(callback)).toBe(CLAUDE);
  });

  it("ignores every other callback", () => {
    expect(clientIdFromCallbackUrl(null)).toBeNull();
    expect(clientIdFromCallbackUrl("/")).toBeNull();
    expect(clientIdFromCallbackUrl("/device?client_id=x")).toBeNull();
    expect(clientIdFromCallbackUrl("https://evil.example/oauth/continue?client_id=x")).toBeNull();
    expect(clientIdFromCallbackUrl("/oauth/continue")).toBeNull();
  });
});

describe("describeRedirectTarget", () => {
  it("shows the origin of a web callback", () => {
    expect(describeRedirectTarget("https://claude.ai/api/mcp/auth_callback")).toEqual({
      label: "https://claude.ai",
      opensPage: true,
    });
  });

  it("treats a custom scheme as an app that leaves this tab open", () => {
    expect(describeRedirectTarget("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({
      label: "cursor",
      opensPage: false,
    });
  });

  it("shows nothing for a missing or broken redirect", () => {
    expect(describeRedirectTarget(null)).toBeNull();
    expect(describeRedirectTarget("::")).toBeNull();
  });
});

describe("workspaceSuffix", () => {
  it("drops a workspace named like its project", () => {
    expect(workspaceSuffix("mcp-e2e", "mcp-e2e")).toBeNull();
    expect(workspaceSuffix("Checkout", " checkout ")).toBeNull();
  });

  it("keeps a workspace that adds something", () => {
    expect(workspaceSuffix("mcp-e2e", "Acme")).toBe("Acme");
  });

  it("has nothing to add without a workspace", () => {
    expect(workspaceSuffix("mcp-e2e", null)).toBeNull();
  });
});
