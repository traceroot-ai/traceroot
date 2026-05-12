import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";

const BACKEND_URL = process.env.PYTHON_BACKEND_URL ?? "http://localhost:8000";
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/trace-tag-keys
// Proxies to Python backend: GET /api/v1/internal/trace-tag-keys
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  try {
    const backendParams = new URLSearchParams({ project_id: projectId });
    const limitParam = req.nextUrl.searchParams.get("limit");
    if (limitParam) backendParams.set("limit", limitParam);

    const res = await fetch(
      `${BACKEND_URL}/api/v1/internal/trace-tag-keys?${backendParams.toString()}`,
      { headers: { "X-Internal-Secret": INTERNAL_SECRET } },
    );
    const body = await res.json();
    return Response.json(body, { status: res.status });
  } catch (err) {
    console.error("[trace-tag-keys proxy] fetch error:", err);
    return errorResponse("Failed to fetch tag keys", 502);
  }
}
