import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { resolveSessionFromToken } from "@/lib/internal-session";
import { checkMintRateLimit, rateLimitClientKey } from "@/lib/mint-rate-limit";

// POST /api/cli/logout
//
// Revokes ONLY the presenting session, server-side. The CLI holds a raw session
// token (its refresh credential) but no cookie, so it cannot use the browser's
// Active Sessions revoke or /api/auth/sign-out (both need a signed cookie).
// bearer() is deliberately off — enabling it would let this token drive every
// /api/auth/* endpoint — so this resolves the token by a direct DB lookup (the
// same path the mint route uses) and deletes that one session row. The delete is
// scoped to the caller's own token; it can never revoke another session.
//
// An access JWT already minted from this session stays valid until its ~10-min
// exp (the backend verifies offline against the JWKS, no per-request lookup), so
// revocation stops FUTURE mints, not the already-issued JWT — the logout UX
// should say the short-lived token lapses within ~10 minutes rather than instantly.
export async function POST(request: NextRequest) {
  // Same in-memory limiter as the mint route, keyed per client IP — the two
  // share one budget, so a client hammering /api/cli/token could throttle its
  // own logout. Acceptable for a one-shot call under the generous cap.
  if (!checkMintRateLimit(rateLimitClientKey(request.headers), 60, 60_000)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const sessionToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!sessionToken) {
    return NextResponse.json({ error: "missing bearer session token" }, { status: 401 });
  }

  // Resolve first, mirroring the mint route's shape. This is for contract
  // fidelity, not safety: the delete below is scoped by the unique token and is
  // harmless on any input, but resolving lets an expired-but-present session
  // report revoked:false (its token no longer resolves) instead of being
  // deleted, and keeps an unknown token a clean no-op.
  const session = await resolveSessionFromToken(sessionToken);
  if (!session) {
    // Already invalid/expired/revoked — from logout's perspective the session is
    // gone, which is the goal state. Idempotent success, not a 401.
    return NextResponse.json({ revoked: false }, { status: 200 });
  }

  // deleteMany (not delete): idempotent if the row vanished between resolve and
  // delete. Scoped by the caller's own token — it cannot touch other sessions.
  await prisma.session.deleteMany({ where: { token: sessionToken } });
  return NextResponse.json({ revoked: true }, { status: 200 });
}
