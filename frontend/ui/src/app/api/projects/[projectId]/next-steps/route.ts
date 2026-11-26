import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { errorResponse, requireAuth, requireProjectAccess } from "@/lib/auth-helpers";
import { resolveFirstTraceReceiveTime } from "@/lib/first-trace-backfill";
import { withImpersonationPolicy } from "@/lib/support/route-guard";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/next-steps
//
// Which of the project home's four next steps the project has done, each read from
// data it already has: a first trace (its first-trace time, filled from the trace
// store for a project whose traces predate it — lib/first-trace-backfill.ts), a
// detector, a signal and an evaluation run. Skipping and hiding are the browser's.
async function handleGET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, firstTraceReceiveTime: true },
  });
  if (!project) return errorResponse("Project not found", 404);

  const exists = { where: { projectId }, select: { id: true } } as const;
  let firstTrace: Date | null;
  let detector: unknown;
  let signal: unknown;
  let evalRun: unknown;
  try {
    [firstTrace, detector, signal, evalRun] = await Promise.all([
      resolveFirstTraceReceiveTime(project),
      prisma.detector.findFirst(exists),
      prisma.signal.findFirst(exists),
      prisma.evaluationRun.findFirst(exists),
    ]);
  } catch (err) {
    // Not knowing whether a step is done is not the same as it not being done.
    console.error("[next-steps] lookup failed:", err);
    return errorResponse("Failed to read the project's next steps", 502);
  }

  return NextResponse.json({
    first_trace: firstTrace !== null,
    detector: detector !== null,
    signal: signal !== null,
    eval_run: evalRun !== null,
  });
}

export const GET = withImpersonationPolicy(handleGET);
