import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { auth } from "@/lib/auth";
import { resolveSessionFromToken } from "@/lib/internal-session";
import { checkMintRateLimit, rateLimitClientKey } from "@/lib/mint-rate-limit";
import { SESSION_EXPIRES_IN_SECONDS, SESSION_UPDATE_AGE_SECONDS } from "@/lib/session-config";

// POST /api/cli/token
//
// Exchanges the CLI's long-lived session token (its refresh credential) for a
// short-lived EdDSA JWT that is the actual request bearer. The session token is
// validated by a direct database lookup (never via bearer() on /api/auth), so
// the session credential stays off the better-auth surface; only a 10-minute
// JWT carrying identity goes on the wire, and the Python backend verifies it
// offline against /api/auth/jwks. The CLI calls this again to refresh before
// expiry. Public endpoint — rate-limited, and 401 without a valid session.

// Must track the jwt() plugin's `expirationTime` in auth.ts (10m). Advisory only
// (the JWT's own `exp` is authoritative); returned so the CLI can schedule refresh.
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

// The issuer + audience the backend pins when verifying. Explicit, purpose-
// specific constants rather than better-auth's default (the app base URL), so
// backend validation doesn't couple to URL config. MUST match the constants the
// backend checks (backend/rest/routers/public/deps.py).
const ACCESS_TOKEN_ISSUER = "traceroot";
const ACCESS_TOKEN_AUDIENCE = "traceroot-api";

// Slide the session on mint so a CLI-only credential expires after a window of
// *inactivity*, not a fixed time from login. The mint path resolves the token by
// a direct DB lookup and never touches better-auth's request machinery, so its
// built-in rolling refresh never fires for the CLI — without this, active daily
// CLI use would still hard-expire the session. Derived from the shared session
// config so the slide can't drift from better-auth's own expiresIn/updateAge.
const SESSION_EXPIRES_IN_MS = SESSION_EXPIRES_IN_SECONDS * 1000;
const SESSION_UPDATE_AGE_MS = SESSION_UPDATE_AGE_SECONDS * 1000;

export async function POST(request: NextRequest) {
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

  const session = await resolveSessionFromToken(sessionToken);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "invalid or expired session" }, { status: 401 });
  }

  // Roll the session's expiry forward, but only when it's older than updateAge —
  // an active CLI mints every ~10 min, so this writes at most once/day per
  // session. Best-effort: a refresh failure must never deny an otherwise-valid
  // mint, so we log and continue rather than surfacing a 500.
  const nowMs = Date.now();
  try {
    await prisma.session.updateMany({
      where: { token: sessionToken, updatedAt: { lt: new Date(nowMs - SESSION_UPDATE_AGE_MS) } },
      data: { expiresAt: new Date(nowMs + SESSION_EXPIRES_IN_MS), updatedAt: new Date(nowMs) },
    });
  } catch (e) {
    console.error("cli/token: session expiry refresh failed (non-fatal)", e);
  }

  // Build the claims explicitly: auth.api.signJWT signs the payload verbatim and
  // only sets `sub` when it is present (definePayload is not consulted here).
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        sub: session.user.id,
        email: session.user.email,
        // The session row id (not the token). Lets the backend's future
        // write-path revocation check confirm this session is still live.
        sid: session.sessionId,
        iss: ACCESS_TOKEN_ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
        iat: Math.floor(Date.now() / 1000),
      },
    },
  });

  return NextResponse.json({
    accessToken: token,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}
