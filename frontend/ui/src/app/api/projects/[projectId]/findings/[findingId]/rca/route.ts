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
    include: {
      // The current execution is the highest attempt; during a re-run that is
      // the running attempt (its session may still be null).
      executions: {
        orderBy: { attempt: "desc" },
        take: 1,
        select: { sessionId: true, traceId: true, traceStatus: true, attempt: true },
      },
    },
  });
  const execution = row?.executions[0] ?? null;
  const rca = row
    ? {
        id: row.id,
        findingId: row.findingId,
        // Legacy fallback only when there is NO execution row at all (an RCA
        // that ran before executions existed). Once one exists it is the
        // authority: a null session on it means that run has no chat, not that
        // an older attempt's chat should be opened.
        sessionId: execution ? execution.sessionId : row.sessionId,
        status: row.status,
        result: row.result,
        completedAt: row.completedAt,
        createTime: row.createTime,
        traceId: execution?.traceId ?? null,
        traceStatus: execution?.traceStatus ?? null,
        attempt: execution?.attempt ?? null,
      }
    : null;
  return successResponse({ rca });
}
