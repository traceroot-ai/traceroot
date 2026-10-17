import { createHash, randomBytes } from "node:crypto";

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
