import { randomBytes, randomUUID } from "node:crypto";
import { getIp } from "@better-auth/core/utils/ip";
import type { Prisma } from "@traceroot/core";
import { env } from "@/env";
import { SESSION_EXPIRES_IN_SECONDS } from "@/lib/session-config";
import { trustedProxyCidrs } from "@/lib/trusted-proxies";

// One place to insert a `sessions` row by hand.
//
// Two flows create a session without going through better-auth's own sign-in:
// support impersonation (lib/support/auth-plugin.ts) and the CLI handoff
// redemption (app/api/cli/handoff/redeem). better-auth has no session
// databaseHooks and no secondaryStorage today (lib/auth.ts), so a hand-rolled
// row IS a real session — but that is an assumption about the library, and the
// point of this helper is that there is exactly one place to fix if it ever
// stops being true.
//
// Everything a session row needs that is not the user id is decided here, so
// the two callers cannot drift from each other or from better-auth:
//
//   - `token` is 256 bits of CSPRNG output. It is the credential; nothing else
//     is.
//   - `expiresAt` comes from SESSION_EXPIRES_IN_SECONDS, the same constant
//     better-auth is configured with (lib/session-config.ts). /api/cli/token
//     slides it forward on use.
//   - `impersonatedBy` defaults to null and must STAY null for anything that
//     is a real login: resolveSessionFromToken rejects impersonated sessions
//     outright (lib/internal-session.ts), so a session created with it set
//     would mint no CLI access token.
//   - `ipAddress` / `userAgent` are read from the request, so the row looks
//     exactly like one better-auth would have written — which is what Active
//     Sessions renders.

/**
 * The slice of a Prisma client this needs. Satisfied by `prisma` and by the
 * client an interactive `$transaction` hands its callback, so a caller can
 * create the session inside a wider transaction.
 */
export type SessionWriter = Pick<Prisma.TransactionClient, "session">;

export interface CreateSessionInput {
  /** The user the session belongs to. */
  userId: string;
  /**
   * Headers of the request that is creating the session. Supplying them records
   * the caller's address and user agent on the row, the way better-auth does
   * for a sign-in; omit them (impersonation) to leave both null.
   */
  headers?: Headers | null;
  /**
   * Support impersonation ONLY — the staff user acting as `userId`. Leave unset
   * for a genuine login; see the note above.
   */
  impersonatedBy?: string | null;
}

/**
 * Resolve the client address exactly as better-auth resolves it for the
 * sessions it writes itself.
 *
 * Deliberately NOT rateLimitClientKey (lib/mint-rate-limit.ts): that takes the
 * last x-forwarded-for hop verbatim, which is the right key for a per-caller
 * bucket but is a different value from the one better-auth stores. better-auth
 * walks the chain from the right, skips hops inside AUTH_TRUSTED_PROXY_CIDRS
 * and normalises IPv6 to a /64, and with no trusted proxies configured it
 * trusts only a single-entry header. Using the limiter's key here would put a
 * subtly different address on a handoff session than on a device-flow one, in
 * the one column users audit.
 *
 * @param headers - The incoming request's headers.
 * @returns The resolved client address, or null when none is trustworthy.
 */
export function clientIpAddress(headers: Headers): string | null {
  return getIp(headers, {
    advanced: { ipAddress: { trustedProxies: trustedProxyCidrs(env.AUTH_TRUSTED_PROXY_CIDRS) } },
  });
}

/**
 * Insert a `sessions` row directly, with the same shape better-auth gives one.
 *
 * @param db - `prisma`, or the client of an open interactive transaction.
 * @param input - Who the session is for and which request is creating it.
 * @returns The created session row, including its `token` and `expiresAt`.
 */
export async function createSession(db: SessionWriter, input: CreateSessionInput) {
  const headers = input.headers ?? null;
  return db.session.create({
    data: {
      id: randomUUID(),
      token: randomBytes(32).toString("hex"),
      userId: input.userId,
      expiresAt: new Date(Date.now() + SESSION_EXPIRES_IN_SECONDS * 1000),
      impersonatedBy: input.impersonatedBy ?? null,
      ipAddress: headers ? clientIpAddress(headers) : null,
      userAgent: headers?.get("user-agent") ?? null,
    },
  });
}
