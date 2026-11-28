import { describe, expect, it } from "vitest";
import { oauthDefaultResource } from "./default-resource";

const RESOURCE = "https://mcp.example.com/mcp";
const [authorizeHook, tokenHook] = oauthDefaultResource(RESOURCE).hooks.before;

// The hooks are middleware endpoints; called directly they run the handler on
// the context given. End-to-end coverage is in provider-flow.integration.test.ts.
type Hook = typeof authorizeHook;
const run = (hook: Hook, context: Record<string, unknown>) =>
  (hook.handler as unknown as (c: unknown) => Promise<unknown>)({ ...context, context: {} });

describe("the default MCP resource", () => {
  it("matches only the authorize and token endpoints", () => {
    expect(authorizeHook.matcher({ path: "/oauth2/authorize" } as never)).toBe(true);
    expect(tokenHook.matcher({ path: "/oauth2/token" } as never)).toBe(true);
    for (const path of ["/oauth2/register", "/oauth2/consent", "/oauth2/introspect"]) {
      expect(authorizeHook.matcher({ path } as never)).toBe(false);
      expect(tokenHook.matcher({ path } as never)).toBe(false);
    }
  });

  it("is added to an authorization that names no resource", async () => {
    expect(await run(authorizeHook, { method: "GET", query: { client_id: "c" } })).toEqual({
      context: { query: { client_id: "c", resource: RESOURCE } },
    });
    expect(await run(authorizeHook, { method: "POST", body: { client_id: "c" } })).toEqual({
      context: { body: { client_id: "c", resource: RESOURCE } },
    });
  });

  it.each(["authorization_code", "refresh_token"])(
    "is added to a %s request that names no resource",
    async (grant_type) => {
      expect(await run(tokenHook, { method: "POST", body: { grant_type } })).toEqual({
        context: { body: { grant_type, resource: RESOURCE } },
      });
    },
  );

  it("leaves a resource the client named for the provider to judge", async () => {
    const other = "https://other.example.com/mcp";
    expect(await run(authorizeHook, { method: "GET", query: { resource: other } })).toBeUndefined();
    expect(
      await run(tokenHook, {
        method: "POST",
        body: { grant_type: "refresh_token", resource: [other] },
      }),
    ).toBeUndefined();
  });

  it("leaves other grants alone", async () => {
    expect(
      await run(tokenHook, { method: "POST", body: { grant_type: "client_credentials" } }),
    ).toBeUndefined();
  });
});
