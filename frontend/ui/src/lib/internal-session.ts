import { auth } from "@/lib/auth";

/**
 * Resolve a better-auth session from a raw bearer session token.
 *
 * Shared by the internal routes the Python backend calls to introspect a user's
 * CLI credential (validate-user-token, user-memberships). Resolves via the
 * bearer plugin, which accepts the session token as an Authorization header in
 * place of the cookie. Returns null when the token is invalid/expired or
 * resolution throws (a bad token is not a 500). Never log the token or headers.
 */
export async function resolveSessionFromToken(
  token: string,
): Promise<Awaited<ReturnType<typeof auth.api.getSession>>> {
  try {
    return await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${token}` }),
    });
  } catch {
    return null;
  }
}
