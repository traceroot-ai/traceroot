import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string; traceId: string }> };

/**
 * Whether detection is queued for a trace, and which detectors to expect. Lets the
 * trace page show "detection in progress" during the ~1min debounce and stop
 * polling once nothing is coming (`sampled_out`) or every run has landed.
 *
 * Returns an empty state on any backend failure: it is a hint, not page data.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, traceId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const empty = { state: null, detector_ids: [] };
  try {
    const res = await fetch(
      `${BACKEND_URL}/api/v1/internal/traces/${encodeURIComponent(traceId)}/detection-state?project_id=${encodeURIComponent(projectId)}`,
      { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
    );
    if (!res.ok) return successResponse(empty);
    return successResponse(await res.json());
  } catch (err) {
    console.error("[trace-detection-state proxy] fetch error:", err);
    return successResponse(empty);
  }
}
