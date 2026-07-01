import { NextRequest } from "next/server";
import { prisma, PlanType, isBillingEnabled } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { validateWorkspaceModelSelection } from "@/lib/server/model-availability";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

type RouteParams = { params: Promise<{ projectId: string; sessionId: string }> };

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readOptionalContextId(
  body: Record<string, unknown>,
  key: "traceId" | "traceSessionId",
): { ok: true; value: string | undefined } | { ok: false; response: Response } {
  const raw = body[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, response: jsonError(`${key} must be a string`, 400) };
  }

  if (raw.length === 0) return { ok: true, value: undefined };
  return { ok: true, value: raw };
}

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("Body must be a JSON object", 400);
  }

  const requestBody = body as Record<string, unknown>;
  if (typeof requestBody.message !== "string" || requestBody.message.trim().length === 0) {
    return jsonError("message must be a non-empty string", 400);
  }
  const traceId = readOptionalContextId(requestBody, "traceId");
  if (!traceId.ok) return traceId.response;
  const traceSessionId = readOptionalContextId(requestBody, "traceSessionId");
  if (!traceSessionId.ok) return traceSessionId.response;

  const modelSelection = await validateWorkspaceModelSelection(accessResult.project.workspaceId, {
    source: requestBody.source,
    provider: requestBody.providerName,
    model: requestBody.model,
  });
  if (!modelSelection.ok) {
    return jsonError(modelSelection.message, modelSelection.status);
  }

  // Check if AI runs are blocked (free plan hard cap — paid plans are never blocked)
  const workspace = await prisma.workspace.findUnique({
    where: { id: accessResult.project.workspaceId },
    select: { aiBlocked: true, billingPlan: true },
  });
  if (isBillingEnabled() && workspace?.aiBlocked && workspace.billingPlan === PlanType.FREE) {
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
        message: requestBody.message,
        model: modelSelection.model,
        providerName: modelSelection.provider,
        source: modelSelection.source,
        traceId: traceId.value,
        traceSessionId: traceSessionId.value,
      }),
      signal: request.signal,
    },
  );

  if (!agentRes.ok) {
    return jsonError("Agent service error", agentRes.status);
  }
  if (!agentRes.body) {
    return jsonError("Agent service error", 502);
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
