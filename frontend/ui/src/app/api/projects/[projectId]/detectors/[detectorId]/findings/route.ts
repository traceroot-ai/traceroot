import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string; detectorId: string }> };

// GET /api/projects/[projectId]/detectors/[detectorId]/findings
// Proxies to Python backend: GET /api/v1/internal/detector-findings
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const { searchParams } = req.nextUrl;
  const rawLimit = parseInt(searchParams.get("limit") ?? "50", 10);
  const rawOffset = parseInt(searchParams.get("offset") ?? "0", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
  const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);
  const since = searchParams.get("since");

  const backendParams = new URLSearchParams({
    project_id: projectId,
    detector_id: detectorId,
    limit: limit.toString(),
    offset: offset.toString(),
  });
  if (since) backendParams.set("since", since);

  let response: Response;
  try {
    response = await fetch(
      `${BACKEND_URL}/api/v1/internal/detector-findings?${backendParams.toString()}`,
      {
        headers: {
          "X-Internal-Secret": INTERNAL_API_SECRET,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("[findings proxy] fetch error:", err);
    return errorResponse("Failed to reach backend", 502);
  }

  const data: unknown = await response.json();
  return Response.json(data, { status: response.status });
}
