import { NextResponse } from "next/server";
import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { prisma } from "@traceroot/core";
import { requireAuth } from "@/lib/auth-helpers";
import { describeOAuthClient } from "@/lib/oauth/client-display";

// GET /api/oauth/connections
//
// The assistants the signed-in user has connected: one row per consent, with the
// project it is limited to and who vouches for the assistant.
async function handleGET() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const consents = await prisma.oauthConsent.findMany({
    where: { userId: authResult.user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      referenceId: true,
      scopes: true,
      createdAt: true,
      client: {
        select: { name: true, clientId: true, clientDiscoveryId: true, redirectUris: true },
      },
    },
  });
  const projectIds = [...new Set(consents.map((c) => c.referenceId).filter(Boolean))] as string[];
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, deleteTime: null },
    select: { id: true, name: true },
  });
  const names = new Map(projects.map((p) => [p.id, p.name]));

  return NextResponse.json({
    connections: consents.map((c) => ({
      id: c.id,
      ...clientFields(c.client),
      projectId: c.referenceId,
      projectName: c.referenceId ? (names.get(c.referenceId) ?? null) : null,
      scopes: c.scopes,
      createdAt: c.createdAt,
    })),
  });
}

// The name to show and the host that vouches for it (null for a client that
// registered itself), as the consent screen showed them.
function clientFields(client: Parameters<typeof describeOAuthClient>[0]) {
  const { name, verifiedHost } = describeOAuthClient(client);
  return { clientName: name, verifiedHost };
}

export const dynamic = "force-dynamic";

export const GET = withImpersonationPolicy(handleGET);
