import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/ai/sessions — List sessions
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const res = await fetch(`${AGENT_SERVICE_URL}/api/v1/projects/${projectId}/sessions`, {
    headers: {
      "x-user-id": user.id,
      "x-workspace-id": accessResult.project.workspaceId,
    },
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: `Agent service error: ${res.status}` }), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = await res.json();
  return successResponse(data);
}

// POST /api/projects/[projectId]/ai/sessions — Create session
export async function POST(request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const body = await request.json();

  const res = await fetch(`${AGENT_SERVICE_URL}/api/v1/projects/${projectId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-user-id": user.id,
      "x-workspace-id": accessResult.project.workspaceId,
    },
    body: JSON.stringify({ title: body.title }),
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: `Agent service error: ${res.status}` }), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = await res.json();
  return successResponse(data, 201);
}
