import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/detector-counts
// Proxies to Python backend: GET /api/v1/internal/detector-counts
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

  const backendParams = new URLSearchParams({
    project_id: projectId,
    start_after: startAfter,
  });
  if (endBefore) backendParams.set("end_before", endBefore);

  let response: Response;
  try {
    response = await fetch(
      `${BACKEND_URL}/api/v1/internal/detector-counts?${backendParams.toString()}`,
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
