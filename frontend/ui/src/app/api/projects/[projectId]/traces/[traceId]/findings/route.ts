import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, PlanType } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { clampStartAfter } from "@/lib/server/retention";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string; traceId: string }> };

async function handleGET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, traceId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  // URL parsers normalize standalone dot segments even after percent-encoding.
  if (traceId === "." || traceId === "..") {
    return Response.json({ error: "Invalid trace ID" }, { status: 400 });
  }

  // A trace outside the plan's retention window can't be opened, so its findings
  // shouldn't be readable either. Pass the plan's cutoff as start_after; enterprise has none.
  const workspace = await prisma.workspace.findUnique({
    where: { id: accessResult.project.workspaceId },
    select: { billingPlan: true },
  });
  const billingPlan = workspace?.billingPlan || PlanType.FREE;
  const startAfter = clampStartAfter(billingPlan, null);

  const qs = new URLSearchParams({ project_id: projectId });
  if (startAfter) qs.set("start_after", startAfter);
  const res = await fetch(
    `${BACKEND_URL}/api/v1/internal/traces/${encodeURIComponent(traceId)}/findings?${qs}`,
    { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
  );
  if (!res.ok)
    return new Response(JSON.stringify({ error: "Backend error" }), { status: res.status });
  const data = await res.json();
  return successResponse(data);
}
export const GET = withImpersonationPolicy(handleGET);
