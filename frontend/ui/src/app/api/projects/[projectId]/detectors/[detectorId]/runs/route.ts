import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, PlanType } from "@traceroot/core";
import { signalsForRuns } from "@traceroot/core/signals";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";
import { clampStartAfter } from "@/lib/server/retention";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string; detectorId: string }> };

// GET /api/projects/[projectId]/detectors/[detectorId]/runs
// Proxies to Python backend: GET /api/v1/internal/detector-runs
async function handleGET(req: NextRequest, { params }: RouteParams) {
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
  startAfter = clampStartAfter(billingPlan, startAfter);

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

  // Attach each triggered run's signal, and the agent trace of the RCA that
  // analysed this run's own trace for that signal (one batched Postgres
  // lookup), so the runs table can link both. Best-effort: on lookup failure the fields are absent and the
  // cells render "—". Runs that never triggered (null finding_id) are left
  // untouched.
  if (response.ok && data !== null && typeof data === "object") {
    const runs = (data as { data?: unknown }).data;
    if (Array.isArray(runs)) {
      const triggered = (runs as Array<Record<string, unknown>>).filter(
        (r) => typeof r.finding_id === "string" && typeof r.run_id === "string",
      );
      if (triggered.length > 0) {
        try {
          const hits = await signalsForRuns(prisma, {
            projectId,
            runIds: triggered.map((r) => r.run_id as string),
          });
          const byRun = new Map(hits.map((h) => [h.runId, h]));
          for (const r of triggered) {
            const hit = byRun.get(r.run_id as string);
            r.signal_id = hit?.signalId ?? null;
            r.agent_trace_id = hit?.agentTraceId ?? null;
          }
        } catch (err) {
          console.error("[runs proxy] signal lookup failed:", err);
        }
      }
    }
  }

  return Response.json(data, { status: response.status });
}
export const GET = withImpersonationPolicy(handleGET);
