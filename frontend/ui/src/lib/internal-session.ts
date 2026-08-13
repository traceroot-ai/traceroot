import { prisma } from "@traceroot/core";

export type ResolvedSession = {
  // The session row id (NOT the token). Rides in the CLI access JWT as `sid` so
  // a future write-path revocation check can verify this specific session is
  // still live (revoking it in Active Sessions deletes the row).
  sessionId: string;
  user: { id: string; email: string };
} | null;

/**
 * Resolve a user from a raw session token via a direct database lookup.
 *
 * Shared by the internal routes the Python backend calls to introspect a user's
 * CLI credential (validate-user-token, user-memberships). Resolving by a direct
 * `session.token` lookup deliberately keeps the credential off the public
 * better-auth surface: enabling the bearer plugin so `auth.api.getSession` would
 * accept an `Authorization: Bearer <token>` header would also let that same CLI
 * token drive every `/api/auth/*` endpoint (update-user, revoke-sessions, …) and
 * would expose session tokens to page JS on sign-in. This resolver only needs to
 * map a live token to its user.
 *
 * Returns null when the token is unknown or expired (a bad token is a 401, not a
 * 500). A database error propagates so an outage surfaces as a 500 rather than a
 * misleading "invalid token". Never log the token.
 */
export async function resolveSessionFromToken(token: string): Promise<ResolvedSession> {
  const session = await prisma.session.findUnique({
    where: { token },
    select: {
      id: true,
      expiresAt: true,
      user: { select: { id: true, email: true } },
    },
  });

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return { sessionId: session.id, user: session.user };
}
