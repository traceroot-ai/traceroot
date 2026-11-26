import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { listLoopRuns } from "@traceroot/core/loops";
import { LOOP_RUN_STATUSES, type LoopRunStatus } from "@traceroot/core/loops/pure";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireLoopRoute } from "@/lib/loop-route";
import { readPaging } from "@/lib/route-helpers";

type RouteParams = { params: Promise<{ projectId: string; loopId: string }> };

const isRunStatus = (value: string): value is LoopRunStatus =>
  (LOOP_RUN_STATUSES as readonly string[]).includes(value);

// GET /api/projects/[projectId]/loops/[loopId]/runs - Runs, newest first.
// Optional `status` narrows to one outcome; `signal_id` to the runs that recorded
// that signal (one of this Loop's), and to none for any other signal.
async function handleGET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params);
  if (auth.error) return auth.error;

  const status = req.nextUrl.searchParams.get("status");
  if (status !== null && !isRunStatus(status)) {
    return errorResponse(`status must be one of: ${LOOP_RUN_STATUSES.join(", ")}`, 400);
  }
  return successResponse(
    await listLoopRuns(prisma, {
      projectId: auth.projectId,
      loop: auth.loop,
      ...readPaging(req),
      status,
      signalId: req.nextUrl.searchParams.get("signal_id"),
    }),
  );
}

export const GET = withImpersonationPolicy(handleGET);
