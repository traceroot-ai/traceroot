import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

// Connecting an assistant hands a project's data to another system, so it is not
// something a support employee can do while impersonating a customer.
export function assertNotImpersonating(session: Record<string, unknown> | null | undefined): void {
  if (session?.impersonatedBy) {
    throw new APIError("FORBIDDEN", {
      message: "Exit impersonation before connecting an assistant",
    });
  }
}

export const isOAuthProviderPath = (path: string | undefined): boolean =>
  typeof path === "string" && path.startsWith("/oauth2/");

// Our own API routes are wrapped by the impersonation policy, but better-auth's
// OAuth endpoints (authorize, consent, continue, the consent list) are not. This
// refuses every one of them to an impersonated session, so no path, including one
// that skips the project picker, can complete a connection for the customer.
// Calls with no session (a client registering, or exchanging a code at the token
// endpoint) are not the user acting and pass through.
export const oauthImpersonationGuard = () =>
  ({
    id: "oauth-impersonation-guard",
    hooks: {
      before: [
        {
          matcher: (context) => isOAuthProviderPath(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            assertNotImpersonating((await getSessionFromCtx(ctx))?.session);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
