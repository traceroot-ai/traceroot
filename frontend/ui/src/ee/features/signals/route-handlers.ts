/**
 * Cookie-route handlers for signals (ee). The route files under app/api only
 * wrap these with the impersonation policy. Every write runs through core
 * ee/signals, which takes the partition lock; a status change records who,
 * when, why and the note in signal_status_events, and hand edits are audited.
 */
import { NextRequest } from "next/server";
import { prisma, Role, PlanType } from "@traceroot/core";
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
  detectorSignalSettings,
  signalSetup,
  signalsKeyConfigured,
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
import { clampStartAfter } from "@/lib/server/retention";
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
  return { user: authResult.user, project: access.project };
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
          assigned_at_ms: moved.assignedAt.getTime(),
          run_ids: runIds,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error(`[signals] failed to rewrite ${runIds.length} assignment copies:`, err);
    }
  }
}

// Keeps the offset a query can ask for bounded, like the alerts list.
const MAX_PAGE = 10_000;
// Bound chart allocation and query work for custom ranges on unlimited-retention plans.
const MAX_WINDOW_DAYS = 10_000;

/**
 * The list page's filter chips, in the predicate shape the trace filters use:
 * status and detector name are picked from lists, the name and id are typed.
 */
const signalFilterSchema = z.array(
  z.discriminatedUnion("field", [
    z.object({
      field: z.literal("status"),
      op: z.literal("in"),
      value: z.array(z.enum(SIGNAL_STATUSES)),
    }),
    z.object({ field: z.literal("detector"), op: z.literal("in"), value: z.array(z.string()) }),
    z.object({ field: z.literal("title"), op: z.literal("contains"), value: z.string() }),
    z.object({ field: z.literal("signal_id"), op: z.literal("eq"), value: z.string() }),
  ]),
);

/**
 * The time window in `start_after` / `end_before` (ISO), or an error message.
 * Both are optional; a missing end is now.
 */
function parseWindow(searchParams: URLSearchParams): {
  window?: { from: Date; to: Date };
  error?: string;
} {
  const start = searchParams.get("start_after");
  const end = searchParams.get("end_before");
  if (!start && !end) return {};
  const from = start ? new Date(start) : null;
  const to = end ? new Date(end) : new Date();
  if (!from || isNaN(from.getTime()) || isNaN(to.getTime())) {
    return { error: "start_after and end_before must be ISO timestamps" };
  }
  if (from.getTime() > to.getTime()) return { error: "start_after must not be after end_before" };
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    return { error: `Signal windows must not exceed ${MAX_WINDOW_DAYS} days` };
  }
  return { window: { from, to } };
}

/** A single retained window for list counts, panel traces and chart populations. */
async function retainedWindow(window: { from: Date; to: Date } | undefined, workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { billingPlan: true },
  });
  const to = window?.to ?? new Date();
  const requested = window?.from ?? new Date(to.getTime() - 7 * 86_400_000);
  const from = new Date(
    clampStartAfter(workspace?.billingPlan ?? PlanType.FREE, requested.toISOString())!,
  );
  return { from: from > to ? to : from, to };
}

/** One page of signals for the query in `req`, as `{ data, meta }` like the other list endpoints. */
async function listResponse(
  req: NextRequest,
  projectId: string,
  workspaceId: string,
  detectorId?: string,
) {
  const { searchParams } = req.nextUrl;
  // The window does not filter signals: it only counts each one's hits in it.
  const { window, error } = parseWindow(searchParams);
  if (error) return errorResponse(error, 400);
  const status = searchParams.get("status");
  if (status && !(SIGNAL_STATUSES as readonly string[]).includes(status)) {
    return errorResponse(`status must be one of ${SIGNAL_STATUSES.join(", ")}`, 400);
  }
  let filters: z.infer<typeof signalFilterSchema> = [];
  const rawFilters = searchParams.get("filters");
  if (rawFilters) {
    let json: unknown;
    try {
      json = JSON.parse(rawFilters);
    } catch {
      return errorResponse("filters must be JSON", 400);
    }
    const parsed = signalFilterSchema.safeParse(json);
    if (!parsed.success) return errorResponse("Unsupported signal filter", 400);
    filters = parsed.data;
  }
  const statuses = new Set<string>(status ? [status] : []);
  const detectorNames: string[] = [];
  let title: string | undefined;
  let signalId: string | undefined;
  for (const f of filters) {
    if (f.field === "status") f.value.forEach((v) => statuses.add(v));
    else if (f.field === "detector") detectorNames.push(...f.value);
    else if (f.field === "title") title = f.value.trim() || undefined;
    else signalId = f.value.trim() || undefined;
  }
  const rawLimit = parseInt(searchParams.get("limit") ?? "50", 10);
  const rawPage = parseInt(searchParams.get("page") ?? "0", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
  const page = isNaN(rawPage) ? 0 : Math.min(Math.max(rawPage, 0), MAX_PAGE);
  const { signals, total } = await listSignals(prisma, {
    projectId,
    detectorIds: detectorId ? [detectorId] : undefined,
    detectorNames: detectorNames.length > 0 ? detectorNames : undefined,
    statuses: statuses.size > 0 ? [...statuses] : undefined,
    title,
    signalId,
    hitsIn: window ? await retainedWindow(window, workspaceId) : undefined,
    page,
    limit,
  });
  return successResponse({ data: signals, meta: { page, limit, total } });
}

// GET /api/projects/[projectId]/signals?filters=&page=&limit=
export async function handleListSignals(
  req: NextRequest,
  { params }: Params<{ projectId: string }>,
) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  return listResponse(req, projectId, auth.project.workspaceId);
}

// GET /api/projects/[projectId]/detectors/[detectorId]/signals?status=open&page=0&limit=50
export async function handleListDetectorSignals(
  req: NextRequest,
  { params }: Params<{ projectId: string; detectorId: string }>,
) {
  const { projectId, detectorId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  return listResponse(req, projectId, auth.project.workspaceId, detectorId);
}

/** Whether `tz` is an IANA zone name this runtime (and so Postgres and ClickHouse) knows. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Which traces the chart compares the signal's against. */
const POPULATIONS = ["similar", "all"] as const;
type Population = (typeof POPULATIONS)[number];

/**
 * Traces per local bucket of the window, read from the backend: the ones the
 * signal's detector checked ("similar"), or all of the project's. Null when the
 * backend cannot be reached, so the chart still shows the signal's own traces.
 */
async function tracesPerBucket(
  projectId: string,
  detectorId: string,
  population: Population,
  window: { from: Date; to: Date; granularity: "hour" | "day" },
  tz: string,
): Promise<Map<string, number> | null> {
  const qs = new URLSearchParams({
    project_id: projectId,
    start_after: window.from.toISOString(),
    end_before: window.to.toISOString(),
    granularity: window.granularity,
    tz,
  });
  if (population === "similar") qs.set("detector_id", detectorId);
  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/internal/trace-counts?${qs}`, {
      headers: { "X-Internal-Secret": env.INTERNAL_API_SECRET || "" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data: { bucket: string; count: number }[] };
    return new Map(body.data.map((d) => [d.bucket, d.count]));
  } catch (err) {
    console.error(`[signals] failed to read the trace counts of project ${projectId}:`, err);
    return null;
  }
}

// GET /api/projects/[projectId]/signals/[signalId]?start_after=&end_before=&tz=&population=similar
// Buckets are the viewer's local hours or days. Each carries the signal's traces
// and, when the backend answers, the other traces of the population.
export async function handleGetSignal(
  req: NextRequest,
  { params }: Params<{ projectId: string; signalId: string }>,
) {
  const { projectId, signalId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  const { searchParams } = req.nextUrl;
  const { window, error } = parseWindow(searchParams);
  if (error) return errorResponse(error, 400);
  const tz = searchParams.get("tz") || "UTC";
  if (!isValidTimeZone(tz)) return errorResponse("tz must be an IANA time zone", 400);
  const population = searchParams.get("population") || "similar";
  if (!(POPULATIONS as readonly string[]).includes(population)) {
    return errorResponse(`population must be one of ${POPULATIONS.join(", ")}`, 400);
  }
  const effectiveWindow = await retainedWindow(window, auth.project.workspaceId);
  const result = await getSignal(prisma, {
    projectId,
    signalId,
    from: effectiveWindow.from,
    to: effectiveWindow.to,
    tz,
  });
  if (!result) return errorResponse("Signal not found", 404);
  if (result.merged) return successResponse(result);
  const counted = await tracesPerBucket(
    projectId,
    result.signal.detectorId,
    population as Population,
    result.window,
    tz,
  );
  return successResponse({
    ...result,
    hitSeries: result.hitSeries.map((b) => ({
      ...b,
      // The bucket's other traces; the clamp covers a hit counted before its trace lands.
      unaffected: counted ? Math.max(0, (counted.get(b.bucket) ?? 0) - b.hits) : null,
    })),
  });
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

/** Detectors whose signals settings one trace read returns, at most. */
const TRACE_DETECTORS_MAX = 200;

// GET /api/projects/[projectId]/traces/[traceId]/signals?detector_ids=a,b
// Each hit of the trace with its signal, the signals settings of the detectors
// named, and whether this deployment groups hits at all, so a hit not grouped
// yet reads as pending or disabled.
export async function handleTraceSignals(
  req: NextRequest,
  { params }: Params<{ projectId: string; traceId: string }>,
) {
  const { projectId, traceId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  const detectorIds = [
    ...new Set(
      (req.nextUrl.searchParams.get("detector_ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (detectorIds.length > TRACE_DETECTORS_MAX) {
    return errorResponse(`At most ${TRACE_DETECTORS_MAX} detector ids`, 400);
  }
  const [hits, detectors] = await Promise.all([
    signalsForTrace(prisma, { projectId, traceId }),
    detectorSignalSettings(prisma, { projectId, detectorIds }),
  ]);
  return successResponse({ hits, detectors, grouping: signalsKeyConfigured() });
}

// GET /api/projects/[projectId]/signals/setup
// Read by the Signals page only when it has nothing to list.
export async function handleSignalSetup(
  _req: NextRequest,
  { params }: Params<{ projectId: string }>,
) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  return successResponse({
    ...(await signalSetup(prisma, projectId)),
    grouping: signalsKeyConfigured(),
  });
}
