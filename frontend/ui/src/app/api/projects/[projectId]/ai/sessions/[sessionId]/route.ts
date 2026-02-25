import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

type RouteParams = { params: Promise<{ projectId: string; sessionId: string }> };

// DELETE /api/projects/[projectId]/ai/sessions/[sessionId] — Delete session
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, sessionId } = await params;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const res = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${projectId}/sessions/${sessionId}`,
    {
      method: "DELETE",
      headers: { "x-user-id": user.id },
    },
  );

  if (!res.ok) {
    return new Response(JSON.stringify({ error: "Failed to delete session" }), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return successResponse({ ok: true });
}
