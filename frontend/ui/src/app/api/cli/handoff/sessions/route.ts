import { NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth } from "@/lib/auth-helpers";
import { HANDOFF_REDEEMED_OPERATION } from "@/lib/cli-handoff";
import { withImpersonationPolicy } from "@/lib/support/route-guard";

// GET /api/cli/handoff/sessions
//
// The ids of the caller's sessions that a handoff redemption created, so Active
// Sessions can show them as their own class. better-auth's list-sessions
// returns only the session row, and a handoff session's row is identical to a
// device-flow login's, so the class comes from the audit row redemption writes
// for each session it creates (see redeem/route.ts). Ids only: unlike the rows
// list-sessions returns, a session id is not a credential.
//
// May name sessions that have since been revoked or expired; the page only
// marks rows list-sessions still returns.
async function handleGET() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const redeemed = await prisma.auditLog.findMany({
    where: {
      actorUserId: authResult.user.id,
      operation: HANDOFF_REDEEMED_OPERATION,
      resourceType: "session",
    },
    select: { resourceId: true },
  });

  return NextResponse.json({ sessionIds: redeemed.map((row) => row.resourceId) });
}

export const GET = withImpersonationPolicy(handleGET);
