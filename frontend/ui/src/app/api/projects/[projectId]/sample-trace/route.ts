import { Role } from "@traceroot/core";
import { env } from "@/env";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string }> };

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

// POST /api/projects/[projectId]/sample-trace - create a demo trace for onboarding.
export async function POST(_request: Request, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/internal/projects/${projectId}/sample-trace`, {
      method: "POST",
      headers: { "X-Internal-Secret": env.INTERNAL_API_SECRET },
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return errorResponse(data?.detail || "Failed to create sample trace", res.status);
    }

    return successResponse(data, 201);
  } catch {
    return errorResponse("Failed to create sample trace", 500);
  }
}
