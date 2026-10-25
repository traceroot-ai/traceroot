import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";
import { prisma, PlanType } from "@traceroot/core";
import { agentRunCountsByDetector } from "@traceroot/core/signals";
import { clampStartAfter } from "@/lib/server/retention";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/detector-counts
// Proxies to Python backend: GET /api/v1/internal/detector-window-summary
// (the UI only reads the counts; the backend endpoint also returns sample traces)
async function handleGET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const { searchParams } = req.nextUrl;
  let startAfter = searchParams.get("start_after");
  const endBefore = searchParams.get("end_before");

  const workspace = await prisma.workspace.findUnique({
    where: { id: accessResult.project.workspaceId },
    select: { billingPlan: true },
  });
  const billingPlan = workspace?.billingPlan || PlanType.FREE;
  startAfter = clampStartAfter(billingPlan, startAfter);

  if (!startAfter) {
    return errorResponse("start_after is required", 400);
  }

  const from = new Date(startAfter);
  const to = endBefore ? new Date(endBefore) : new Date();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return errorResponse("start_after and end_before must be timestamps", 400);
  }
  if (from > to) return errorResponse("start_after must not be after end_before", 400);

  const backendParams = new URLSearchParams({
    project_id: projectId,
    start_after: startAfter,
  });
  if (endBefore) backendParams.set("end_before", endBefore);

  let response: Response;
  try {
    response = await fetch(
      `${BACKEND_URL}/api/v1/internal/detector-window-summary?${backendParams.toString()}`,
      {
        headers: {
          "X-Internal-Secret": INTERNAL_API_SECRET,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("[detector-counts proxy] fetch error:", err);
    return errorResponse("Failed to reach backend", 502);
  }

  const body = await response.json();
  if (!response.ok) return Response.json(body, { status: response.status });

  let agentCounts: Record<string, number>;
  try {
    agentCounts = await agentRunCountsByDetector(prisma, { projectId, from, to });
  } catch (err) {
    console.error("[detector-counts] agent-run counts failed:", err);
    return errorResponse("Failed to read agent-run counts", 500);
  }
  const counts: Record<string, Record<string, unknown>> = body.data;
  for (const detectorId of new Set([...Object.keys(counts), ...Object.keys(agentCounts)])) {
    counts[detectorId] = {
      finding_count: 0,
      run_count: 0,
      ...counts[detectorId],
      agent_run_count: agentCounts[detectorId] ?? 0,
    };
  }
  return Response.json(body);
}
export const GET = withImpersonationPolicy(handleGET);
