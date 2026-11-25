import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { errorResponse, requireAuth, requireProjectAccess } from "@/lib/auth-helpers";
import { resolveFirstTraceReceiveTime } from "@/lib/first-trace-backfill";
import { withImpersonationPolicy } from "@/lib/support/route-guard";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/first-trace
//
// When the project first received a trace, or null while it has none. A project
// whose traces predate the recorded time is filled from the trace store on this
// read, without sending any event (lib/first-trace-backfill.ts).
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

  let firstTraceReceiveTime: Date | null;
  try {
    firstTraceReceiveTime = await resolveFirstTraceReceiveTime(project);
  } catch (err) {
    console.error("[first-trace] trace store lookup failed:", err);
    return errorResponse("Failed to reach backend", 502);
  }
  return NextResponse.json({
    first_trace_receive_time: firstTraceReceiveTime?.toISOString() ?? null,
  });
}

export const GET = withImpersonationPolicy(handleGET);
