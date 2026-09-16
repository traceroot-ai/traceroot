import type { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess } from "@/lib/auth-helpers";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

type RouteParams = { params: Promise<{ projectId: string; sessionId: string }> };

// POST /api/projects/[projectId]/ai/sessions/[sessionId]/decisions — forward
// the user's decision on a parked write (create/skip/revise) to the agent
// service. The service's status codes pass through untouched: the panel needs
// 409 (already decided) and 404 (unknown or expired decision) to resolve a
// pending card without erroring the transcript.
export async function POST(request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, sessionId } = await params;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const res = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${projectId}/sessions/${sessionId}/decisions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": user.id,
      },
      body: JSON.stringify({
        decisionId: body.decisionId,
        action: body.action,
        ...(body.text === undefined ? {} : { text: body.text }),
      }),
    },
  );

  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
