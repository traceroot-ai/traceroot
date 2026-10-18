import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import {
  HANDOFF_CODE_PATTERN,
  HANDOFF_REDEEMED_OPERATION,
  hashHandoffCode,
} from "@/lib/cli-handoff";
import { createSession } from "@/lib/create-session";
import { readLimitedJson } from "@/lib/eval/body";
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
// logout`) learns a new case. Active Sessions is the one place that does tell
// it apart, from the audit row written beside it (see the end of the
// transaction below).

const redeemSchema = z.object({ code: z.string().min(1, "code is required") });

// Tighter than the mint: this is the brute-force surface and it is the one
// unauthenticated path. Against 256 bits of entropy the limiter is a formality,
// but it bounds the database work an anonymous flood can force. Prefixed so it
// gets its own budget rather than sharing one with /api/cli/token (the limiter
// is a single process-wide map keyed only by client address).
const REDEEM_MAX_PER_WINDOW = 10;
const REDEEM_WINDOW_MS = 60_000;

// The body this route accepts is one 47-character code, so a kilobyte is already
// two decimal orders of headroom. The rate limiter bounds how MANY anonymous
// requests are served, not how large one of them is, so without a ceiling a
// caller inside its budget could still make the web process buffer and parse an
// arbitrarily long body. readLimitedJson refuses an oversized declared length
// before reading anything, and stops reading a body that declares none
// (chunked) as soon as it passes the ceiling.
const MAX_BODY_BYTES = 1024;

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

  const body = await readLimitedJson(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const parsed = redeemSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  // A value that is not shaped like a minted code cannot be one, so it is
  // answered with the same 401 the lookup would have produced -- no hash, no
  // query, and no new response for an attacker to tell apart from a code that
  // simply does not exist. The shape is public (the CLI prints it), so matching
  // on it reveals nothing the caller did not already know about its own input.
  if (!HANDOFF_CODE_PATTERN.test(parsed.data.code)) {
    return NextResponse.json(INVALID, { status: 401 });
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
        issuedBySessionId: true,
        projectId: true,
        workspaceId: true,
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
      // Records the redeemer's own address and agent (`traceroot-cli/<version>`
      // for the CLI), the way a device-flow session records them.
      headers: request.headers,
    });

    // So a later question about where a session came from has an answer.
    await tx.cliHandoff.update({
      where: { id: handoff.id },
      data: { redeemedSessionId: session.id },
    });

    // The record that sets this session apart. A redeemed code buys a full,
    // sliding account session with no interaction, on a row nothing
    // distinguishes from a device-flow login, so a code stolen from the page
    // would otherwise become a credential the user cannot tell from their own.
    // Active Sessions marks every session named by one of these rows, and,
    // unlike cli_handoffs, nothing sweeps the audit trail. Written in this
    // transaction rather than best-effort after it: a handoff session without
    // it is exactly the unmarked credential this is here to prevent, so if it
    // cannot be written the redemption rolls back and the code stays live.
    //
    // It also records whether the code was spent from a different address than
    // the tab that minted it. Recorded, never refused: the hand-back step says
    // to run the command where the application lives, which is routinely
    // another host. The minting side is the issuing session's address as
    // better-auth stored it at sign-in, resolved the same way as the
    // redeemer's; the comparison is null when that session is gone or either
    // address is unknown.
    const issuer = handoff.issuedBySessionId
      ? await tx.session.findUnique({
          where: { id: handoff.issuedBySessionId },
          select: { ipAddress: true },
        })
      : null;
    const mintedFrom = issuer?.ipAddress ?? null;
    const redeemedFrom = session.ipAddress ?? null;
    await tx.auditLog.create({
      data: {
        actorUserId: handoff.userId,
        actorEmail: handoff.user.email,
        operation: HANDOFF_REDEEMED_OPERATION,
        resourceType: "session",
        resourceId: session.id,
        workspaceId: handoff.workspaceId,
        projectId: handoff.projectId,
        transport: "cli",
        outcome: "success",
        summary: {
          handoffId: handoff.id,
          issuedBySessionId: handoff.issuedBySessionId,
          mintedFrom,
          redeemedFrom,
          addressChanged: mintedFrom && redeemedFrom ? mintedFrom !== redeemedFrom : null,
        },
      },
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
