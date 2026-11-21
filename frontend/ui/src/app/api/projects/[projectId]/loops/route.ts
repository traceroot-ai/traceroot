import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { listLoops } from "@traceroot/core/loops";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireLoopRoute } from "@/lib/loop-route";
import { parseJsonObject, readPaging } from "@/lib/route-helpers";
import { createLoop } from "@/lib/write-services/loops";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/loops - List the project's Loops with their
// last run, run count, mean cost and signal count. `search_query` matches names.
async function handleGET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params);
  if (auth.error) return auth.error;

  const { page, limit } = readPaging(req);
  const result = await listLoops(prisma, {
    projectId: auth.projectId,
    search: req.nextUrl.searchParams.get("search_query")?.trim() || null,
    page,
    limit,
  });
  return successResponse(result);
}

// POST /api/projects/[projectId]/loops - Create a Loop (and its hidden detector)
async function handlePOST(req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params, Role.MEMBER);
  if (auth.error) return auth.error;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  const result = await createLoop({
    body: parsed.body,
    actorUserId: auth.user.id,
    projectId: auth.projectId,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ loop: result.data }, 201);
}

export const GET = withImpersonationPolicy(handleGET);
export const POST = withImpersonationPolicy(handlePOST);
