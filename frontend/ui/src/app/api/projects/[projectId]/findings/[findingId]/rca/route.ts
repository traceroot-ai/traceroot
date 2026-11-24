import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, type NextResponse } from "next/server";
import { getRetentionDays, PlanType, prisma } from "@traceroot/core";
import {
  errorResponse,
  requireAuth,
  requireProjectAccess,
  successResponse,
} from "@/lib/auth-helpers";
import { isOutsideRetention } from "@/lib/server/retention";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = env.INTERNAL_API_SECRET || "";

type RouteParams = {
  params: Promise<{ projectId: string; findingId: string }>;
};

type FindingTraceStart = {
  trace_start_time: string | null;
  timestamp: string;
};

/** A time from the backend as a Date; anything but a string is an invalid date. */
function parseTime(value: unknown): Date {
  return typeof value === "string" ? new Date(value) : new Date(NaN);
}

/**
 * Gate an RCA read against the workspace plan's retention window using the
 * customer trace's start time (not the finding/RCA processing time).
 *
 * The backend resolves the customer root span's start, falling back to the
 * earliest customer span when the root has not arrived. When the trace has no
 * customer span at all, the gate takes the earlier of the finding's oldest
 * stored `timestamp` and the RCA row's `createTime`. A ClickHouse merge keeps
 * only a finding's newest version, so a re-run can make `timestamp` recent,
 * while nothing rewrites `createTime`.
 *
 * Fails closed: a failed or unreadable backend answer, including one without
 * `trace_start_time`, returns 502 instead of the RCA, a 404 hides it as
 * `{ rca: null }`, and a trace that started before the cutoff returns 403. A
 * database error throws, as the RCA lookup in the handler does, so it ends in a
 * 500 without the RCA.
 */
async function checkRcaRetention(
  projectId: string,
  workspaceId: string,
  findingId: string,
  rcaCreatedAt: Date,
): Promise<NextResponse | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { billingPlan: true },
  });
  const billingPlan = workspace?.billingPlan || PlanType.FREE;
  if (getRetentionDays(billingPlan) === null) {
    return null;
  }

  const qs = new URLSearchParams({ project_id: projectId });
  let res: Response;
  try {
    res = await fetch(
      `${BACKEND_URL}/api/v1/internal/findings/${encodeURIComponent(findingId)}/trace-start?${qs}`,
      { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
    );
  } catch {
    return errorResponse("Backend error", 502);
  }

  if (res.status === 404) {
    return successResponse({ rca: null });
  }
  if (!res.ok) {
    return errorResponse("Backend error", 502);
  }

  let body: FindingTraceStart;
  try {
    body = (await res.json()) as FindingTraceStart;
  } catch {
    return errorResponse("Backend error", 502);
  }

  // Only an explicit null means "no customer span"; an answer without the
  // field parses as an invalid date and fails. An invalid date (NaN) also
  // survives Math.min, so a bad `timestamp` still fails.
  const judgedAt =
    body?.trace_start_time !== null
      ? parseTime(body?.trace_start_time)
      : new Date(Math.min(parseTime(body.timestamp).getTime(), rcaCreatedAt.getTime()));
  if (isNaN(judgedAt.getTime())) {
    return errorResponse("Backend error", 502);
  }
  if (isOutsideRetention(billingPlan, judgedAt)) {
    return errorResponse("Data outside retention window", 403);
  }

  return null;
}

async function handleGET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const { projectId, findingId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const row = await prisma.detectorRca.findFirst({
    where: { findingId, projectId },
    include: {
      // Newest first. A finding has one execution per attempt, so this is a
      // handful of rows at most.
      executions: {
        orderBy: { attempt: "desc" },
        select: { sessionId: true, traceId: true, traceStatus: true, attempt: true },
      },
    },
  });
  if (!row) return successResponse({ rca: null });

  const blocked = await checkRcaRetention(
    projectId,
    accessResult.project.workspaceId,
    row.findingId,
    row.createTime,
  );
  if (blocked) return blocked;

  // The current execution is the highest attempt; during a re-run that is the
  // running attempt (its session may still be null, its trace still pending).
  const current = row.executions[0] ?? null;
  // The trace link must survive a retry: while attempt n+1 is pending, attempt
  // n's trace is still the one that can be opened. Fall back to the current
  // execution's (pending/failed/disabled) status only when no attempt has an
  // available trace.
  const trace = row.executions.find((e) => e.traceStatus === "available") ?? current;
  const rca = {
    id: row.id,
    findingId: row.findingId,
    // Legacy fallback only when there is NO execution row at all (an RCA
    // that ran before executions existed). Once one exists it is the
    // authority: a null session on it means that run has no chat, not that
    // an older attempt's chat should be opened.
    sessionId: current ? current.sessionId : row.sessionId,
    status: row.status,
    result: row.result,
    completedAt: row.completedAt,
    createTime: row.createTime,
    traceId: trace?.traceId ?? null,
    traceStatus: trace?.traceStatus ?? null,
    attempt: current?.attempt ?? null,
  };
  return successResponse({ rca });
}
export const GET = withImpersonationPolicy(handleGET);
