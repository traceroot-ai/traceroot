/**
 * Cookie-route handlers for signals (ee). The route files under app/api only
 * wrap these with the impersonation policy. Every write runs through core
 * ee/signals, which takes the partition lock; a status change records who,
 * when, why and the note in signal_status_events, and hand edits are audited.
 */
import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import {
  SIGNAL_STATUSES,
  editSignalCriteria,
  getSignal,
  listSignals,
  mergeSignals,
  moveHit,
  setSignalStatus,
  signalCriteriaEditSchema,
  signalStatusChangeSchema,
  signalsForTrace,
  type MovedHits,
  type SignalStatus,
} from "@traceroot/core/signals";
import { z } from "zod";
import { env } from "@/env";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/write-services/audit";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
/** Runs per reassign call; the backend accepts at most this many. */
const REASSIGN_CHUNK = 1000;

type Params<T> = { params: Promise<T> };

async function readJson(req: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

async function authorize(projectId: string, role?: Role) {
  const authResult = await requireAuth();
  if (authResult.error) return { error: authResult.error };
  const access = await requireProjectAccess(authResult.user.id, projectId, role);
  if (access.error) return { error: access.error };
  return { user: authResult.user };
}

/**
 * Point the ClickHouse copies of moved hits at their new signal. Postgres is
 * already committed and is what every reader uses; a failure here leaves the
 * copies stale, so it is logged rather than failing the user's edit.
 */
async function rewriteCopies(moved: MovedHits): Promise<void> {
  for (let i = 0; i < moved.runIds.length; i += REASSIGN_CHUNK) {
    const runIds = moved.runIds.slice(i, i + REASSIGN_CHUNK);
    try {
      const res = await fetch(`${BACKEND_URL}/api/v1/internal/signals/reassign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": env.INTERNAL_API_SECRET || "",
        },
        body: JSON.stringify({
          project_id: moved.projectId,
          detector_id: moved.detectorId,
          signal_id: moved.signalId,
          run_ids: runIds,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error(`[signals] failed to rewrite ${runIds.length} assignment copies:`, err);
    }
  }
}

// GET /api/projects/[projectId]/detectors/[detectorId]/signals?status=open
export async function handleListDetectorSignals(
  req: NextRequest,
  { params }: Params<{ projectId: string; detectorId: string }>,
) {
  const { projectId, detectorId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  const status = req.nextUrl.searchParams.get("status");
  if (status && !(SIGNAL_STATUSES as readonly string[]).includes(status)) {
    return errorResponse(`status must be one of ${SIGNAL_STATUSES.join(", ")}`, 400);
  }
  const signals = await listSignals(prisma, { projectId, detectorId, status: status ?? undefined });
  return successResponse({ signals });
}

// GET /api/projects/[projectId]/signals/[signalId]
export async function handleGetSignal(
  _req: NextRequest,
  { params }: Params<{ projectId: string; signalId: string }>,
) {
  const { projectId, signalId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  const result = await getSignal(prisma, { projectId, signalId });
  if (!result) return errorResponse("Signal not found", 404);
  return successResponse(result);
}

// PATCH /api/projects/[projectId]/signals/[signalId] — title and criteria
export async function handleEditSignal(
  req: NextRequest,
  { params }: Params<{ projectId: string; signalId: string }>,
) {
  const { projectId, signalId } = await params;
  const auth = await authorize(projectId, Role.MEMBER);
  if (auth.error) return auth.error;
  const json = await readJson(req);
  if (!json.ok) return errorResponse("Invalid JSON", 400);
  const parsed = signalCriteriaEditSchema.safeParse(json.body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);
  const result = await editSignalCriteria(prisma, { projectId, signalId, edit: parsed.data });
  if (!result.ok) return errorResponse(result.error, result.status);
  await writeAudit(prisma, {
    actorUserId: auth.user.id,
    operation: "edit_signal_criteria",
    resourceType: "signal",
    resourceId: signalId,
    projectId,
    summary: { criteriaVersion: result.criteriaVersion },
    transport: "ui",
  });
  return successResponse({ criteriaVersion: result.criteriaVersion });
}

const statusBodySchema = z.object({
  change: z.unknown(),
  /** The status the user saw; a different current status is a conflict. */
  expectedStatus: z.enum(SIGNAL_STATUSES).optional(),
});

// POST /api/projects/[projectId]/signals/[signalId]/status
// { change: { status, reason?, note? }, expectedStatus? }
export async function handleSetSignalStatus(
  req: NextRequest,
  { params }: Params<{ projectId: string; signalId: string }>,
) {
  const { projectId, signalId } = await params;
  const auth = await authorize(projectId, Role.MEMBER);
  if (auth.error) return auth.error;
  const json = await readJson(req);
  if (!json.ok) return errorResponse("Invalid JSON", 400);
  const body = statusBodySchema.safeParse(json.body);
  if (!body.success) return errorResponse(body.error.issues[0].message, 400);
  const change = signalStatusChangeSchema.safeParse(body.data.change);
  if (!change.success) return errorResponse(change.error.issues[0].message, 400);
  const result = await setSignalStatus(prisma, {
    projectId,
    signalId,
    actorUserId: auth.user.id,
    change: change.data,
    expectedStatus: body.data.expectedStatus as SignalStatus | undefined,
  });
  if (!result.ok) {
    if (result.code === "not_found") return errorResponse("Signal not found", 404);
    if (result.code === "merged") {
      return Response.json(
        { error: "Signal was merged", mergedIntoId: result.mergedIntoId },
        { status: 409 },
      );
    }
    return Response.json(
      { error: "The status changed since you opened it", status: result.status },
      { status: 409 },
    );
  }
  return successResponse({ status: result.status, changed: result.changed });
}

const mergeBodySchema = z.object({ targetSignalId: z.string().min(1) });

// POST /api/projects/[projectId]/signals/[signalId]/merge { targetSignalId }
export async function handleMergeSignal(
  req: NextRequest,
  { params }: Params<{ projectId: string; signalId: string }>,
) {
  const { projectId, signalId } = await params;
  const auth = await authorize(projectId, Role.MEMBER);
  if (auth.error) return auth.error;
  const json = await readJson(req);
  if (!json.ok) return errorResponse("Invalid JSON", 400);
  const body = mergeBodySchema.safeParse(json.body);
  if (!body.success) return errorResponse("targetSignalId is required", 400);
  const result = await mergeSignals(prisma, {
    projectId,
    sourceId: signalId,
    targetId: body.data.targetSignalId,
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  await rewriteCopies(result.moved);
  await writeAudit(prisma, {
    actorUserId: auth.user.id,
    operation: "merge_signal",
    resourceType: "signal",
    resourceId: signalId,
    projectId,
    summary: { into: body.data.targetSignalId, hits: result.moved.runIds.length },
    transport: "ui",
  });
  return successResponse({
    mergedInto: body.data.targetSignalId,
    movedHits: result.moved.runIds.length,
  });
}

const moveBodySchema = z.object({ signalId: z.string().min(1) });

// PATCH /api/projects/[projectId]/signal-hits/[runId] { signalId }
export async function handleMoveHit(
  req: NextRequest,
  { params }: Params<{ projectId: string; runId: string }>,
) {
  const { projectId, runId } = await params;
  const auth = await authorize(projectId, Role.MEMBER);
  if (auth.error) return auth.error;
  const json = await readJson(req);
  if (!json.ok) return errorResponse("Invalid JSON", 400);
  const body = moveBodySchema.safeParse(json.body);
  if (!body.success) return errorResponse("signalId is required", 400);
  const result = await moveHit(prisma, { projectId, runId, targetId: body.data.signalId });
  if (!result.ok) return errorResponse(result.error, result.status);
  await rewriteCopies(result.moved);
  if (result.moved.runIds.length > 0) {
    await writeAudit(prisma, {
      actorUserId: auth.user.id,
      operation: "move_signal_hit",
      resourceType: "signal_hit",
      resourceId: runId,
      projectId,
      summary: { to: body.data.signalId },
      transport: "ui",
    });
  }
  return successResponse({ signalId: body.data.signalId });
}

// GET /api/projects/[projectId]/traces/[traceId]/signals
export async function handleTraceSignals(
  _req: NextRequest,
  { params }: Params<{ projectId: string; traceId: string }>,
) {
  const { projectId, traceId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  return successResponse({ hits: await signalsForTrace(prisma, { projectId, traceId }) });
}
