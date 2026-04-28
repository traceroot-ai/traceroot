import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

type RouteParams = {
  params: Promise<{ projectId: string; findingId: string }>;
};

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const { projectId, findingId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const rca = await prisma.detectorRca.findFirst({
    where: { findingId, projectId },
  });
  return successResponse({ rca });
}
