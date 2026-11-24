import type { CimdOptions } from "@better-auth/cimd";
import { pinnedMetadataFetch } from "@/lib/oauth/pinned-fetch";

type FetchResource = CimdOptions["fetchClientMetadataResource"];

// Options for better-auth's cimd plugin, which lets an assistant identify itself
// by the URL of a JSON document describing it (its name and redirect URIs)
// instead of registering first. Assistants that support it use it in preference
// to dynamic registration, so one client row serves all of their users.
//
// Policy: any public HTTPS host may serve a document, not an allowlist. A new
// assistant should not need a release to connect, and a document grants nothing
// on its own: the client it creates is clamped to the same scopes and resource
// as a dynamically registered one (mcpOAuthProviderOptions), and every
// authorization still goes through sign-in, the project picker and consent.
//
// The plugin refuses document URLs on private, loopback or reserved hosts, a
// document whose client_id is not its own URL, and symmetric client secrets. The
// transport (pinned-fetch.ts) resolves the host once, refuses any private answer,
// pins the address for the connection, follows no redirects and accepts up to
// 64 KiB of response headers; the plugin caps a fetch at 5 s and 5 KB. The same
// transport fetches a document's jwks_uri, which is how a private_key_jwt client
// is authenticated.
export function mcpCimdOptions(fetchResource: FetchResource = pinnedMetadataFetch()) {
  return {
    fetchClientMetadataResource: fetchResource,
    // Requires client_name and redirect_uris, as the MCP authorization spec does.
    metadataProfile: "mcp-2026-07-28",
    // A new client row is only written after a fetch, so the fetch budget is
    // also the budget for creating clients. Tighter than the plugin's defaults:
    // a known assistant's document is cached for an hour, so real traffic is a
    // few fetches an hour per assistant. Per-instance memory, so a coarse bound
    // like the rate limits in auth.ts.
    metadataFetchPolicy: {
      maximumFetchesPerMinute: 60,
      maximumFetchesPerOriginPerMinute: 10,
    },
  } satisfies CimdOptions;
}
