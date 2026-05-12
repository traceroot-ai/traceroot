import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";

const BACKEND_URL = process.env.PYTHON_BACKEND_URL ?? "http://localhost:8000";
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/trace-tag-values?key=model
// Proxies to Python backend: GET /api/v1/internal/trace-tag-values
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const key = req.nextUrl.searchParams.get("key");
  if (!key) {
    return errorResponse("key query parameter is required", 400);
  }

  try {
    const backendParams = new URLSearchParams({ project_id: projectId, key });
    const limitParam = req.nextUrl.searchParams.get("limit");
    if (limitParam) backendParams.set("limit", limitParam);

    const res = await fetch(
      `${BACKEND_URL}/api/v1/internal/trace-tag-values?${backendParams.toString()}`,
      { headers: { "X-Internal-Secret": INTERNAL_SECRET } },
    );
    const body = await res.json();
    return Response.json(body, { status: res.status });
  } catch (err) {
    console.error("[trace-tag-values proxy] fetch error:", err);
    return errorResponse("Failed to fetch tag values", 502);
  }
}
