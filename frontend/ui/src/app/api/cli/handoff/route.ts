import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role } from "@traceroot/core";
import { env } from "@/env";
import { requireAuth, requireProjectAccess } from "@/lib/auth-helpers";
import {
  HANDOFF_TTL_SECONDS,
  generateHandoffCode,
  hashHandoffCode,
  pruneExpiredHandoffs,
} from "@/lib/cli-handoff";
import { checkMintRateLimit, rateLimitClientKey } from "@/lib/mint-rate-limit";
import { getRequestSession } from "@/lib/request-session";
import { withImpersonationPolicy } from "@/lib/support/route-guard";

// POST /api/cli/handoff
//
// Mints the single-use ticket that lets browser-first onboarding hand the
// terminal a session without a second browser page. The hand-back step calls
// this with the browser's own session cookie and prints the code on the
// `traceroot setup` line; `setup` exchanges it at /api/cli/handoff/redeem for
// an ordinary session row.
//
// It lives here, beside /api/cli/token and /api/cli/logout, rather than as a
// better-auth plugin endpoint: a plugin endpoint would sit under /api/auth/*,
// which is the surface this codebase has twice gone out of its way to keep CLI
// credentials off (bearer() is deliberately disabled, see lib/auth.ts).
//
// The row it writes records the project and workspace, but those are audit
// detail and the CLI's confirmation line -- NOT an authorization scope. What a
// redeemed handoff yields is a full user session, identical in power to
// pressing Approve on /device. The project check below exists so the page
// cannot mint a handoff naming a project the user has no business in, and so
// the stored row is an honest record.

const mintSchema = z.object({ projectId: z.string().min(1, "projectId is required") });

// Per client, per minute. A session is required, so the flood risk is lower
// than on the public redeem route; this mostly bounds how many live codes a
// hijacked tab can churn through. The key is prefixed because the limiter is
// one process-wide map keyed only by client address: without the prefix this
// route would share a budget with /api/cli/token and /api/cli/logout, and the
// tighter cap here would start denying mints after someone else's traffic.
const MINT_MAX_PER_WINDOW = 10;
const MINT_WINDOW_MS = 60_000;

async function handlePOST(request: NextRequest) {
  if (
    !checkMintRateLimit(
      `cli-handoff-mint:${rateLimitClientKey(request.headers)}`,
      MINT_MAX_PER_WINDOW,
      MINT_WINDOW_MS,
    )
  ) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  // Cookie-authenticated POST. better-auth's cookies are SameSite=Lax, which
  // already blocks a cross-site fetch from carrying them, but an explicit
  // origin check costs nothing. Behind TLS termination request.url can hold the
  // internal listener host, so trust deployment configuration and never a
  // caller-controlled forwarding header.
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(env.BETTER_AUTH_URL).origin) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = mintSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const access = await requireProjectAccess(user.id, parsed.data.projectId, Role.MEMBER);
  if (access.error) return access.error;

  // Resolved from the same request session requireAuth just used (the support
  // route guard shares one resolution per request), so this costs nothing. It
  // records which tab issued the ticket, so a redemption can be traced back.
  const session = await getRequestSession();

  const code = generateHandoffCode();
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000);

  const handoff = await prisma.$transaction(async (tx) => {
    // One live handoff per user. Re-minting is then self-cleaning -- the page
    // can refresh or re-render freely -- and the number of simultaneously valid
    // codes for an account is one, so a hijacked tab cannot stockpile tickets.
    // Scoped to unredeemed rows so a code claimed a moment ago by the user's
    // own terminal keeps its provenance.
    //
    // The lock keeps that true when two mints for one user overlap (two
    // onboarding tabs, or a refresh firing as a second tab mounts). At READ
    // COMMITTED each statement sees only rows committed before it started, so
    // two overlapping delete-then-insert pairs would each delete nothing and
    // both insert. Taken first, the lock makes the second mint wait for the
    // first to commit, and its delete then sees and removes the first row.
    // Released when the transaction ends. Keyed under 'cli_handoffs' so it never
    // meets another feature's advisory locks; two users whose ids hash alike
    // only serialize, which is harmless. `$executeRaw`, not `$queryRaw`: the
    // function returns void, which Prisma cannot deserialize as a column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cli_handoffs'), hashtext(${user.id}))`;
    await tx.cliHandoff.deleteMany({ where: { userId: user.id, redeemedAt: null } });
    return tx.cliHandoff.create({
      data: {
        codeHash: hashHandoffCode(code),
        userId: user.id,
        issuedBySessionId: session?.session.id ?? null,
        projectId: access.project.id,
        workspaceId: access.project.workspaceId,
        expiresAt,
      },
    });
  });

  // Sweep spent rows on the one authenticated path that writes this table; see
  // pruneExpiredHandoffs for why there is no job to extend instead. A failure
  // here must never deny an otherwise-valid mint.
  pruneExpiredHandoffs().catch((e) => {
    console.error("cli/handoff: pruning expired handoffs failed (non-fatal)", e);
  });

  return NextResponse.json({
    code,
    expiresIn: HANDOFF_TTL_SECONDS,
    expiresAt: handoff.expiresAt.toISOString(),
  });
}

export const POST = withImpersonationPolicy(handlePOST);
