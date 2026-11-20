import { NextRequest, NextResponse } from "next/server";
import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { prisma } from "@traceroot/core";
import { errorResponse, requireAuth } from "@/lib/auth-helpers";

// DELETE /api/oauth/connections/[consentId]
//
// Disconnects an assistant: removes the consent and the client's tokens for this
// user. The backend checks the consent on every request, so the assistant loses
// access on its next call rather than when its token expires.
async function handleDELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ consentId: string }> },
) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { consentId } = await params;

  const consent = await prisma.oauthConsent.findFirst({
    where: { id: consentId, userId: authResult.user.id },
    select: { id: true, clientId: true, referenceId: true },
  });
  if (!consent) return errorResponse("Connection not found", 404);

  const tokenScope = {
    userId: authResult.user.id,
    clientId: consent.clientId,
    referenceId: consent.referenceId,
  };
  await prisma.$transaction([
    prisma.oauthAccessToken.deleteMany({ where: tokenScope }),
    prisma.oauthRefreshToken.deleteMany({ where: tokenScope }),
    prisma.oauthConsent.delete({ where: { id: consent.id } }),
  ]);
  return NextResponse.json({ ok: true });
}

export const DELETE = withImpersonationPolicy(handleDELETE);
