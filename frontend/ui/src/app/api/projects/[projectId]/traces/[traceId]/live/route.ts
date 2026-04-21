import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess } from "@/lib/auth-helpers";

const TRACE_API_URL = process.env.TRACE_API_URL || "http://localhost:8000";

type RouteParams = { params: Promise<{ projectId: string; traceId: string }> };

// GET /api/projects/[projectId]/traces/[traceId]/live — SSE proxy for live trace streaming
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, traceId } = await params;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const backendRes = await fetch(
    `${TRACE_API_URL}/api/v1/projects/${projectId}/traces/${traceId}/live`,
    {
      headers: { "x-user-id": user.id },
    },
  );

  if (!backendRes.ok || !backendRes.body) {
    return new Response(JSON.stringify({ error: "Failed to connect to live stream" }), {
      status: backendRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Passthrough the SSE stream
  return new Response(backendRes.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
