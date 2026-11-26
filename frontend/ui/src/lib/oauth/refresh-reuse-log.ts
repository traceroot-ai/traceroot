import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { prisma } from "@traceroot/core";

type RefreshTokenRow = {
  clientId: string;
  revoked: Date | null;
  rotatedAt: Date | null;
  rotationReplayExpiresAt: Date | null;
};

/** Reads one refresh token row by its stored form; the Prisma client in production. */
export type RefreshTokenLookup = (storedToken: string) => Promise<RefreshTokenRow | null>;

const prismaLookup: RefreshTokenLookup = (token) =>
  prisma.oauthRefreshToken.findUnique({
    where: { token },
    select: { clientId: true, revoked: true, rotatedAt: true, rotationReplayExpiresAt: true },
  });

/**
 * The form the provider stores a refresh token in (its default "hashed"
 * storage): SHA-256, base64url without padding. Only this form is ever read.
 */
export function storedRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * One log line when an assistant presents a refresh token that was already
 * rotated: its client id, how long after the rotation, and whether that is
 * inside the reuse window (the provider replays its earlier response) or after
 * it (the provider revokes every refresh token the assistant holds for that
 * user). Reuse after the window looks like theft but is more often a client
 * that lost a response or refreshes from two places at once; the ages tell
 * which, and so whether the window is long enough. A token revoked without
 * being rotated gets a separate line. No token value is logged.
 */
export async function logRefreshTokenReuse(
  refreshToken: string,
  lookup: RefreshTokenLookup = prismaLookup,
  now: Date = new Date(),
): Promise<void> {
  const row = await lookup(storedRefreshToken(refreshToken));
  if (!row?.revoked) return;
  if (!row.rotatedAt) {
    // Revoked without a rotation (/oauth2/revoke, e.g. when the user unlinks):
    // not a reuse, so it gets its own line, aged from the revocation.
    const revokedSeconds = Math.round((now.getTime() - row.revoked.getTime()) / 1000);
    console.warn(
      `[oauth] revoked refresh token presented: client_id=${row.clientId} age_s=${revokedSeconds}`,
    );
    return;
  }
  const ageSeconds = Math.round((now.getTime() - row.rotatedAt.getTime()) / 1000);
  const withinWindow = row.rotationReplayExpiresAt !== null && row.rotationReplayExpiresAt >= now;
  console.warn(
    `[oauth] refresh token reused: client_id=${row.clientId} age_s=${ageSeconds} ` +
      `within_reuse_window=${withinWindow}`,
  );
}

// Watches refresh requests for reused tokens, before the provider handles them
// (afterwards a reuse past the window has deleted the row). Logging only: it
// never changes the request, and a failed lookup is logged and ignored.
export const oauthRefreshReuseLog = (lookup: RefreshTokenLookup = prismaLookup) =>
  ({
    id: "oauth-refresh-reuse-log",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as Record<string, unknown> | undefined;
            const token = body?.refresh_token;
            if (body?.grant_type !== "refresh_token" || typeof token !== "string" || !token) {
              return;
            }
            try {
              await logRefreshTokenReuse(token, lookup);
            } catch (error) {
              console.error("[oauth] refresh token reuse check failed:", error);
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
