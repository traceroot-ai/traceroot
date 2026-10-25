import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
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
  const qs = new URLSearchParams({ project_id: projectId });
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
