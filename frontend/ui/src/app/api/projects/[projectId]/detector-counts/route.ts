import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";
import { prisma, PlanType } from "@traceroot/core";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

const PLAN_RETENTION_DAYS: Record<string, number | null> = {
  [PlanType.FREE]: 15,
  [PlanType.STARTER]: 30,
  [PlanType.PRO]: 90,
  [PlanType.ENTERPRISE]: null,
};
const FAIL_CLOSED_DAYS = 15;

function checkRetention(billingPlan: string, startAfter: string): NextResponse | null {
  const days = PLAN_RETENTION_DAYS[billingPlan] ?? FAIL_CLOSED_DAYS;
  if (days === null) return null;
  const cutoff = new Date(Date.now() - days * 86_400_000 - 3_600_000);
  if (new Date(startAfter) < cutoff) {
    return NextResponse.json(
      {
        detail: {
          message: "Data outside retention window",
          retention_days: days,
          cutoff: cutoff.toISOString(),
          plan: billingPlan,
        },
      },
      { status: 403 },
    );
  }
  return null;
}

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/detector-counts
// Proxies to Python backend: GET /api/v1/internal/detector-window-summary
// (the UI only reads the counts; the backend endpoint also returns sample traces)
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const { searchParams } = req.nextUrl;
  const startAfter = searchParams.get("start_after");
  const endBefore = searchParams.get("end_before");

  if (!startAfter) {
    return errorResponse("start_after is required", 400);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: accessResult.project.workspaceId },
    select: { billingPlan: true },
  });
  const billingPlan = workspace?.billingPlan || PlanType.FREE;
  const retentionError = checkRetention(billingPlan, startAfter);
  if (retentionError) return retentionError;

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

  const data: unknown = await response.json();
  return Response.json(data, { status: response.status });
}
