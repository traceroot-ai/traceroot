import { NextRequest } from "next/server";
import { prisma, ModelSource, isBillingEnabled } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

type RouteParams = { params: Promise<{ projectId: string; sessionId: string }> };

// GET /api/projects/[projectId]/ai/sessions/[sessionId]/messages — Load message history
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, sessionId } = await params;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const res = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${projectId}/sessions/${sessionId}/messages`,
    {
      headers: { "x-user-id": user.id },
    },
  );

  if (!res.ok) {
    return new Response(JSON.stringify({ error: "Failed to load messages" }), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = await res.json();
  return successResponse(data);
}

// POST /api/projects/[projectId]/ai/sessions/[sessionId]/messages — SSE passthrough
export async function POST(request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, sessionId } = await params;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const body = await request.json();

  // Validate BYOK source: verify workspace actually has a configured provider
  if (body.source === ModelSource.BYOK) {
    const hasConfiguredByok = await prisma.modelProvider.findFirst({
      where: { workspaceId: accessResult.project.workspaceId },
    });
    if (!hasConfiguredByok) {
      return new Response(JSON.stringify({ error: "No BYOK provider configured." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Check if AI runs are blocked (free plan hard cap — applies to both system model and BYOK)
  const workspace = await prisma.workspace.findUnique({
    where: { id: accessResult.project.workspaceId },
    select: { aiBlocked: true },
  });
  if (isBillingEnabled() && workspace?.aiBlocked) {
    return new Response(
      JSON.stringify({
        error: "AI run limit reached. Upgrade your plan to continue.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  // Proxy to agent service, passthrough SSE stream
  const agentRes = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${projectId}/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": user.id,
        "x-workspace-id": accessResult.project.workspaceId,
      },
      body: JSON.stringify({
        message: body.message,
        model: body.model,
        providerName: body.providerName,
        source: body.source,
        traceId: body.traceId,
        traceSessionId: body.traceSessionId,
      }),
    },
  );

  if (!agentRes.ok || !agentRes.body) {
    return new Response(JSON.stringify({ error: "Agent service error" }), {
      status: agentRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Passthrough the SSE stream
  return new Response(agentRes.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
