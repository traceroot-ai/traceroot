import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  successResponse,
  errorResponse,
} from "@/lib/auth-helpers";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string; traceId: string }> };

interface BackendRun {
  detector_id: string;
  name?: string;
  [key: string]: unknown;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, traceId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  let res: Response;
  try {
    const qs = new URLSearchParams({ project_id: projectId });
    res = await fetch(
      `${BACKEND_URL}/api/v1/internal/traces/${encodeURIComponent(traceId)}/detector-runs?${qs}`,
      { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
    );
  } catch (err) {
    console.error("[trace-detector-runs proxy] fetch error:", err);
    return errorResponse("Failed to reach backend", 502);
  }
  if (!res.ok) return errorResponse("Backend error", res.status);
  const data = (await res.json()) as { runs?: BackendRun[] };
  if (!Array.isArray(data.runs)) return successResponse({ runs: [] });

  // Join the human-readable detector name from Postgres. One query sized to the
  // trace's detector ids; falls back to the id when a detector was deleted.
  const detectorIds = Array.from(new Set(data.runs.map((r) => r.detector_id))).sort();
  if (detectorIds.length > 0) {
    const detectors = await prisma.detector.findMany({
      where: { projectId, id: { in: detectorIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(detectors.map((d) => [d.id, d.name]));
    for (const run of data.runs) {
      run.name = nameById.get(run.detector_id) ?? run.detector_id;
    }
  }

  return successResponse(data);
}
