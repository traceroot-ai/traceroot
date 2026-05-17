import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string; traceId: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, traceId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;
  const res = await fetch(
    `${BACKEND_URL}/api/v1/internal/traces/${traceId}/findings?project_id=${projectId}`,
    { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
  );
  if (!res.ok)
    return new Response(JSON.stringify({ error: "Backend error" }), { status: res.status });
  const data = await res.json();
  return successResponse(data);
}
