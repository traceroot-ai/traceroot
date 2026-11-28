import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

type Params = Record<string, unknown> | undefined;

// Grants whose tokens are for the MCP server: the code exchange and its refresh.
const USER_GRANTS = new Set(["authorization_code", "refresh_token"]);

const namesResource = (params: Params): boolean => {
  const value = params?.resource;
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value !== "";
};

// The resource parameter (RFC 8707) is what makes the provider issue a JWT whose
// `aud` is the MCP server; without it the token is opaque and the API cannot
// verify it, so every tool call would fail. Not every assistant sends it, and the
// MCP server is the only resource there is, so a request that names none is
// taken to name that one. A request that names a different resource is left as
// it is, and the provider refuses it.
//
// The authorization request may arrive as a query (GET) or a form (POST). What it
// names is carried through sign-in, the project picker and consent in the signed
// query, and stored with the code, so the token request inherits it as well.
export const oauthDefaultResource = (resource: string) =>
  ({
    id: "oauth-default-resource",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.method === "POST") {
              if (!namesResource(ctx.body)) return { context: { body: { ...ctx.body, resource } } };
            } else if (!namesResource(ctx.query)) {
              return { context: { query: { ...ctx.query, resource } } };
            }
          }),
        },
        {
          matcher: (context) => context.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as Params;
            if (USER_GRANTS.has(String(body?.grant_type)) && !namesResource(body)) {
              return { context: { body: { ...body, resource } } };
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
