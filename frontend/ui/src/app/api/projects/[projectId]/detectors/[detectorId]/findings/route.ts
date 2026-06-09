import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = { params: Promise<{ projectId: string; detectorId: string }> };

// GET /api/projects/[projectId]/detectors/[detectorId]/findings
// Proxies to Python backend: GET /api/v1/internal/detector-findings
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const { searchParams } = req.nextUrl;
  const rawLimit = parseInt(searchParams.get("limit") ?? "50", 10);
  const rawPage = parseInt(searchParams.get("page") ?? "0", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
  const page = isNaN(rawPage) ? 0 : Math.max(rawPage, 0);
  const startAfter = searchParams.get("start_after");
  const endBefore = searchParams.get("end_before");
  const searchQuery = searchParams.get("search_query");

  const backendParams = new URLSearchParams({
    project_id: projectId,
    detector_id: detectorId,
    limit: limit.toString(),
    page: page.toString(),
  });
  if (startAfter) backendParams.set("start_after", startAfter);
  if (endBefore) backendParams.set("end_before", endBefore);
  if (searchQuery) backendParams.set("search_query", searchQuery);

  let response: Response;
  try {
    response = await fetch(
      `${BACKEND_URL}/api/v1/internal/detector-findings?${backendParams.toString()}`,
      {
        headers: {
          "X-Internal-Secret": INTERNAL_API_SECRET,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("[findings proxy] fetch error:", err);
    return errorResponse("Failed to reach backend", 502);
  }

  const data: unknown = await response.json();

  // Enrich each finding with its stored RCA status (one batched Postgres
  // lookup) so the findings table can show whether the agent analysis ran.
  // Same source of truth as the trace viewer's Alert gating: a DetectorRca row
  // exists iff RCA ran; an absent row means it was skipped (RCA disabled on
  // every detector that fired). Best-effort: on lookup failure the field is
  // simply absent and the UI renders "—" rather than a misleading "Skipped".
  if (response.ok && data !== null && typeof data === "object") {
    const findings = (data as { data?: unknown }).data;
    if (Array.isArray(findings)) {
      const ids = findings
        .map((f) => (f as { finding_id?: unknown }).finding_id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0) {
        try {
          const rcas = await prisma.detectorRca.findMany({
            where: { findingId: { in: ids } },
            select: { findingId: true, status: true },
          });
          const statusByFinding = new Map(rcas.map((r) => [r.findingId, r.status]));
          for (const f of findings as Array<Record<string, unknown>>) {
            f.rca_status = statusByFinding.get(f.finding_id as string) ?? null;
          }
        } catch (err) {
          console.error("[findings proxy] RCA status lookup failed:", err);
        }
      }
    }
  }

  return Response.json(data, { status: response.status });
}
