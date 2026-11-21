import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { listMemory } from "@traceroot/core/loops";
import { successResponse } from "@/lib/auth-helpers";
import { requireLoopRoute } from "@/lib/loop-route";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/loop-memory - The project's Loop memory, shared
// by all its Loops (`loopId` on a note is the Loop that last wrote it).
// Expired notes are hidden unless `include_expired=true`.
async function handleGET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params);
  if (auth.error) return auth.error;

  const memories = await listMemory(prisma, {
    projectId: auth.projectId,
    now: new Date(),
    includeExpired: req.nextUrl.searchParams.get("include_expired") === "true",
  });
  return successResponse({ data: memories });
}

export const GET = withImpersonationPolicy(handleGET);
