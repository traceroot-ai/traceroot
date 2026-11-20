import { NextResponse } from "next/server";
import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { prisma } from "@traceroot/core";
import { requireAuth } from "@/lib/auth-helpers";

// GET /api/oauth/connections
//
// The assistants the signed-in user has connected: one row per consent, with the
// project it is limited to.
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
      client: { select: { name: true, clientId: true } },
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
      clientName: c.client.name ?? "Unnamed application",
      projectId: c.referenceId,
      projectName: c.referenceId ? (names.get(c.referenceId) ?? null) : null,
      scopes: c.scopes,
      createdAt: c.createdAt,
    })),
  });
}

export const dynamic = "force-dynamic";

export const GET = withImpersonationPolicy(handleGET);
