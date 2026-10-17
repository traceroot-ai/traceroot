import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@traceroot/core";
import { SESSION_EXPIRES_IN_SECONDS } from "@/lib/session-config";

// The handoff credential shared by the two /api/cli/handoff routes. Minting and
// redemption MUST agree on the hash, so both derive it here.
//
// What goes on the printed `traceroot setup` line is a ticket, not a
// credential: it buys exactly one call to /api/cli/handoff/redeem and
// authorizes nothing else. The credential it yields -- a session token -- only
// ever travels in a response body.

// Ten minutes. The budget is the gap between the hand-back step rendering the
// line and the user pressing Enter on it; redemption is the first thing
// `traceroot setup` does, so the code is spent seconds into a run, not at the
// end of one. Deliberately NOT the device flow's 30 minutes: that window is
// sized for a sign-up round trip whose pending artifact is inert without a
// human approving it in an authenticated browser. A handoff code is approved by
// nobody, so its window is the minimum that inconveniences no one. It is also
// the lifetime the product already uses for its other short-lived credential,
// the CLI access JWT (lib/auth.ts).
export const HANDOFF_TTL_SECONDS = 10 * 60;

// `trh_` makes the value greppable by a secret scanner, and it deliberately
// does NOT trip the CLI's API-key sniffer (`/^tr[_-]/`, which needs `_` or `-`
// at index 2), so a handoff code can never be mistaken for a project key.
// base64url is [A-Za-z0-9_-]: a subset of the characters the hand-back step
// already certifies as safe to print unquoted in a shell line, so the code goes
// on that line as a bare word with no quoting.
const HANDOFF_CODE_PREFIX = "trh_";

// Keep an expired row long enough that the session it minted cannot outlive
// its own provenance: redeemedSessionId has to stay answerable for as long as
// that session can still be presented.
const HANDOFF_RETENTION_MS = SESSION_EXPIRES_IN_SECONDS * 1000;

/**
 * Mint a handoff code: 256 bits of CSPRNG output behind the `trh_` prefix.
 *
 * @returns The raw code. It is returned to the browser once and never stored.
 */
export function generateHandoffCode(): string {
  return `${HANDOFF_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * The value stored in `cli_handoffs.code_hash`.
 *
 * SHA-256 hex, not a password KDF: the input is 256 bits of CSPRNG output, so
 * there is no offline guessing to slow down, and a lookup by hash has to be a
 * single indexed equality read. The raw code is never written to the table, so
 * a read of it yields nothing usable.
 *
 * @param code - The raw handoff code.
 * @returns Lowercase hex SHA-256 digest.
 */
export function hashHandoffCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Delete handoff rows that expired long enough ago to have no audit value left.
 *
 * Nothing prunes the adjacent `device_codes` table. Its expiry index says it
 * "supports pruning expired rows (cleanup)", but there is no sweeper anywhere
 * in the repository -- no scheduled task, no worker job, no cron -- and
 * better-auth's device plugin only deletes a row it happens to look up, so an
 * abandoned device code is never collected. Rather than invent a scheduler for
 * one small table, `cli_handoffs` sweeps itself on the one authenticated,
 * rate-limited path that writes to it.
 *
 * That is enough here because the table cannot grow quickly: the mint keeps at
 * most one unredeemed row per user, so what accumulates is spent rows at the
 * rate handoffs are minted, and `ix_cli_handoff_expires_at` makes the delete an
 * indexed range scan.
 *
 * Best effort by contract: a caller must not let a failure here fail its own
 * request.
 *
 * @param now - Current epoch ms (injectable for tests).
 * @returns The number of rows deleted.
 */
export async function pruneExpiredHandoffs(now: number = Date.now()): Promise<number> {
  const { count } = await prisma.cliHandoff.deleteMany({
    where: { expiresAt: { lt: new Date(now - HANDOFF_RETENTION_MS) } },
  });
  return count;
}
