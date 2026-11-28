import { createHash, timingSafeEqual } from "crypto";
import { isUsableSecret } from "@traceroot/core/agent-service";

/**
 * Verify internal API secret for Python backend calls.
 *
 * One credential for every internal caller — the Python backend, the worker
 * and the agent service, whose tools call this app for GitHub App tokens.
 *
 * Compared in constant time (crypto.timingSafeEqual) so response timing cannot
 * be used to recover the secret byte-by-byte. Both sides are hashed first so
 * the compared buffers always have equal length — timingSafeEqual throws on a
 * length mismatch, and any length-dependent early exit would leak the secret's
 * length. Fails closed on a missing header or a blank configured secret (env
 * validation already rejects the latter at boot; guarded here anyway).
 */
export function verifyInternalSecret(request: Request): boolean {
  const provided = request.headers.get("X-Internal-Secret");
  const expected = process.env.INTERNAL_API_SECRET;
  if (!provided || !isUsableSecret(expected)) {
    return false;
  }
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
