import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { hashHandoffCode } from "@/lib/cli-handoff";
import { createSession } from "@/lib/create-session";
import { checkMintRateLimit, rateLimitClientKey } from "@/lib/mint-rate-limit";
import { SESSION_EXPIRES_IN_SECONDS } from "@/lib/session-config";

// POST /api/cli/handoff/redeem
//
// Exchanges a handoff code for an ordinary session token. Unauthenticated by
// construction -- the whole point is that the caller has no credential yet --
// so the same posture as /api/cli/token: public, rate-limited, and a 401
// otherwise.
//
// What comes back is the same artifact a device-flow approval produces: a
// `sessions` row with a null impersonatedBy, created through lib/create-session
// so nothing downstream (/api/cli/token, the backend's JWT check, `traceroot
// logout`, Active Sessions) learns a new case.

const redeemSchema = z.object({ code: z.string().min(1, "code is required") });

// Tighter than the mint: this is the brute-force surface and it is the one
// unauthenticated path. Against 256 bits of entropy the limiter is a formality,
// but it bounds the database work an anonymous flood can force. Prefixed so it
// gets its own budget rather than sharing one with /api/cli/token (the limiter
// is a single process-wide map keyed only by client address).
const REDEEM_MAX_PER_WINDOW = 10;
const REDEEM_WINDOW_MS = 60_000;

// One response for unknown, expired, already-redeemed and banned alike.
// Distinguishing them turns this endpoint into an oracle that confirms a
// guessed or observed code was once real -- information an attacker can act on
// and a legitimate CLI has no use for.
const INVALID = { error: "invalid or expired handoff code" };

export async function POST(request: NextRequest) {
  if (
    !checkMintRateLimit(
      `cli-handoff-redeem:${rateLimitClientKey(request.headers)}`,
      REDEEM_MAX_PER_WINDOW,
      REDEEM_WINDOW_MS,
    )
  ) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const codeHash = hashHandoffCode(parsed.data.code);
  const now = new Date();

  const redeemed = await prisma.$transaction(async (tx) => {
    // The claim. A single UPDATE whose WHERE carries the preconditions is what
    // makes redemption single-use: Postgres takes the row lock, and a
    // concurrent redeemer blocks there and then re-evaluates this WHERE against
    // the committed row, finds redeemed_at no longer null, and matches nothing.
    // Reading the row first and updating it after would be a race with two
    // winners. Zero rows affected means the code is unknown, expired or already
    // spent -- the route cannot tell which, and deliberately does not try.
    const claim = await tx.cliHandoff.updateMany({
      where: { codeHash, redeemedAt: null, expiresAt: { gt: now } },
      data: { redeemedAt: now },
    });
    if (claim.count === 0) return null;

    // Safe to read back: this transaction holds the row's lock, the mint's
    // one-live-handoff delete is scoped to UNREDEEMED rows, and the sweeper
    // only touches rows long past expiry.
    const handoff = await tx.cliHandoff.findUnique({
      where: { codeHash },
      select: {
        id: true,
        userId: true,
        user: { select: { email: true, banned: true, banExpires: true } },
      },
    });
    if (!handoff) return null;

    // A ban landing inside the ten-minute window must not be undone by a
    // ticket minted before it. Same 401 as every other failure.
    const banned =
      handoff.user.banned === true &&
      (!handoff.user.banExpires || handoff.user.banExpires.getTime() > Date.now());
    if (banned) return null;

    const session = await createSession(tx, {
      userId: handoff.userId,
      // Records the CLI's own address and `traceroot-cli/<version>` agent, so
      // Active Sessions labels this exactly as it labels a device-flow session.
      headers: request.headers,
    });

    // So a later question about where a session came from has an answer.
    await tx.cliHandoff.update({
      where: { id: handoff.id },
      data: { redeemedSessionId: session.id },
    });

    return { sessionToken: session.token, email: handoff.user.email };
  });

  if (!redeemed) {
    return NextResponse.json(INVALID, { status: 401 });
  }

  return NextResponse.json({
    sessionToken: redeemed.sessionToken,
    email: redeemed.email,
    expiresIn: SESSION_EXPIRES_IN_SECONDS,
  });
}
