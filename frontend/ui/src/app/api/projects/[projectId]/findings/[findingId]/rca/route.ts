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

  const row = await prisma.detectorRca.findFirst({
    where: { findingId, projectId },
    include: { latestExecution: true },
  });
  const rca = row
    ? {
        id: row.id,
        findingId: row.findingId,
        sessionId: row.latestExecution?.sessionId ?? row.sessionId,
        status: row.status,
        result: row.result,
        completedAt: row.completedAt,
        createTime: row.createTime,
        traceId: row.latestExecution?.traceId ?? null,
        traceStatus: row.latestExecution?.traceStatus ?? null,
        attempt: row.latestExecution?.attempt ?? null,
      }
    : null;
  return successResponse({ rca });
}
