import { NextRequest } from "next/server";
import { prisma, PlanType } from "@traceroot/core";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";
import { checkRetention, getRetentionCutoff } from "@/lib/server/retention";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string; detectorId: string }> };

// GET /api/projects/[projectId]/detectors/[detectorId]/runs
// Proxies to Python backend: GET /api/v1/internal/detector-runs
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const { searchParams } = req.nextUrl;
  const rawLimit = parseInt(searchParams.get("limit") ?? "50", 10);
  const rawPage = parseInt(searchParams.get("page") ?? "0", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
  const page = isNaN(rawPage) ? 0 : Math.max(rawPage, 0);
  let startAfter = searchParams.get("start_after");
  const endBefore = searchParams.get("end_before");
  const searchQuery = searchParams.get("search_query");
  const identified = searchParams.get("identified");

  const workspace = await prisma.workspace.findUnique({
    where: { id: accessResult.project.workspaceId },
    select: { billingPlan: true },
  });
  const billingPlan = workspace?.billingPlan || PlanType.FREE;

  if (startAfter) {
    const retentionError = checkRetention(billingPlan, startAfter);
    if (retentionError) return retentionError;
  } else {
    const cutoff = getRetentionCutoff(billingPlan);
    if (cutoff) startAfter = cutoff;
  }

  const backendParams = new URLSearchParams({
    project_id: projectId,
    detector_id: detectorId,
    limit: limit.toString(),
    page: page.toString(),
  });
  if (startAfter) backendParams.set("start_after", startAfter);
  if (endBefore) backendParams.set("end_before", endBefore);
  if (searchQuery) backendParams.set("search_query", searchQuery);
  if (identified === "true") backendParams.set("identified", "true");

  let response: Response;
  try {
    response = await fetch(
      `${BACKEND_URL}/api/v1/internal/detector-runs?${backendParams.toString()}`,
      {
        headers: {
          "X-Internal-Secret": INTERNAL_API_SECRET,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("[runs proxy] fetch error:", err);
    return errorResponse("Failed to reach backend", 502);
  }

  const data: unknown = await response.json();

  // Enrich each triggered run with its stored RCA status (one batched Postgres
  // lookup) so the findings view (identified runs) can show whether the agent
  // analysis ran. Same source of truth as the trace viewer's Alert gating: a
  // DetectorRca row exists iff RCA ran; an absent row (null) means it was
  // skipped (RCA disabled on every detector that fired). Best-effort: on lookup
  // failure the field is simply absent and the UI renders "—". Runs that never
  // triggered (null finding_id) are left untouched.
  if (response.ok && data !== null && typeof data === "object") {
    const runs = (data as { data?: unknown }).data;
    if (Array.isArray(runs)) {
      const ids = runs
        .map((r) => (r as { finding_id?: unknown }).finding_id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0) {
        try {
          const rcas = await prisma.detectorRca.findMany({
            where: { findingId: { in: ids } },
            select: { findingId: true, status: true },
          });
          const statusByFinding = new Map(rcas.map((r) => [r.findingId, r.status]));
          for (const r of runs as Array<Record<string, unknown>>) {
            if (typeof r.finding_id === "string") {
              r.rca_status = statusByFinding.get(r.finding_id) ?? null;
            }
          }
        } catch (err) {
          console.error("[runs proxy] RCA status lookup failed:", err);
        }
      }
    }
  }

  return Response.json(data, { status: response.status });
}
