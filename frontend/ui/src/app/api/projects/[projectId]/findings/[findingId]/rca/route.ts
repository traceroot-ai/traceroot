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
      // Newest first. A finding has one execution per attempt, so this is a
      // handful of rows at most.
      executions: {
        orderBy: { attempt: "desc" },
        select: { sessionId: true, traceId: true, traceStatus: true, attempt: true },
      },
    },
  });
  // The current execution is the highest attempt; during a re-run that is the
  // running attempt (its session may still be null, its trace still pending).
  const current = row?.executions[0] ?? null;
  // The trace link must survive a retry: while attempt n+1 is pending, attempt
  // n's trace is still the one that can be opened. Fall back to the current
  // execution's (pending/failed/disabled) status only when no attempt has an
  // available trace.
  const trace = row?.executions.find((e) => e.traceStatus === "available") ?? current;
  const rca = row
    ? {
        id: row.id,
        findingId: row.findingId,
        // Legacy fallback only when there is NO execution row at all (an RCA
        // that ran before executions existed). Once one exists it is the
        // authority: a null session on it means that run has no chat, not that
        // an older attempt's chat should be opened.
        sessionId: current ? current.sessionId : row.sessionId,
        status: row.status,
        result: row.result,
        completedAt: row.completedAt,
        createTime: row.createTime,
        traceId: trace?.traceId ?? null,
        traceStatus: trace?.traceStatus ?? null,
        attempt: current?.attempt ?? null,
      }
    : null;
  return successResponse({ rca });
}
