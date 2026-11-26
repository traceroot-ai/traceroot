import { NextRequest, NextResponse } from "next/server";
import { Role } from "@traceroot/core";
import { errorResponse, requireAuth, requireProjectAccess } from "@/lib/auth-helpers";
import { env } from "@/env";
import { withImpersonationPolicy } from "@/lib/support/route-guard";

type RouteParams = { params: Promise<{ projectId: string }> };

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

// POST /api/projects/[projectId]/sample-trace
//
// Adds the sample trace to a project that has no traces yet, so its trace view can be
// explored before anything is instrumented. It writes to the project, so viewers
// cannot.
async function handlePOST(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let response: Response;
  try {
    response = await fetch(
      `${BACKEND_URL}/api/v1/internal/projects/${encodeURIComponent(projectId)}/sample-trace`,
      {
        method: "POST",
        headers: { "X-Internal-Secret": env.INTERNAL_API_SECRET },
        cache: "no-store",
      },
    );
  } catch (err) {
    console.error("[sample-trace] backend unreachable:", err);
    return errorResponse("Failed to reach backend", 502);
  }
  if (response.status === 409) return errorResponse("This project already has traces", 409);
  if (!response.ok) {
    console.error("[sample-trace] backend answered", response.status);
    return errorResponse("Failed to create the sample trace", 502);
  }
  const body = (await response.json()) as { trace_id: string };
  return NextResponse.json({ trace_id: body.trace_id }, { status: 201 });
}

export const POST = withImpersonationPolicy(handlePOST);
