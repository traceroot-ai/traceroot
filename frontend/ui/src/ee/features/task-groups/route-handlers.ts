/**
 * Cookie-route handlers for task groups (shown as "Topics"). The route files under
 * app/api only wrap these with the impersonation policy. Reads go through the Python
 * backend (the groups live in ClickHouse); the switch, the cap and the refresh request
 * live in Postgres and are written here.
 */
import { NextRequest } from "next/server";
import { isValid, parseISO } from "date-fns";
import { z } from "zod";
import { prisma, Role, PlanType } from "@traceroot/core";
import { signalsKeyConfigured } from "@traceroot/core/signals";
import {
  MIN_DIGESTS_FOR_GROUPS,
  REFRESH_MIN_INTERVAL_MS,
  readTaskGroupState,
  requestTaskGroupRefresh,
} from "@traceroot/core/task-groups";
import {
  errorResponse,
  requireAuth,
  requireProjectAccess,
  successResponse,
} from "@/lib/auth-helpers";
import { DEMO_VIEWER_FORBIDDEN, isDemoViewer } from "@/lib/demo-workspace";
import { clampStartAfter } from "@/lib/server/retention";
import type { TaskGroupsOverview, TaskGroupRow } from "./types";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const BACKEND_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
/** Longest range one call reads; the backend caps the trend the same way. */
const MAX_RANGE_DAYS = 120;
/** The fit reads this many days of summaries (mirrors the backend's FIT_WINDOW_DAYS). */
const FIT_WINDOW_DAYS = 14;
const MAX_BY_TRACE_IDS = 200;

type Params<T> = { params: Promise<T> };

async function authorize(projectId: string, role?: Role) {
  const authResult = await requireAuth();
  if (authResult.error) return { error: authResult.error };
  const access = await requireProjectAccess(authResult.user.id, projectId, role);
  if (access.error) return { error: access.error };
  return { user: authResult.user, project: access.project, membership: access.membership };
}

async function backendGet<T>(path: string, params: URLSearchParams): Promise<T> {
  const response = await fetch(`${BACKEND_URL}/api/v1/internal/task-groups${path}?${params}`, {
    headers: { "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "" },
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`task-group backend ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/** The UTC days from `from` to `to`, oldest first, as YYYY-MM-DD. */
export function daysBetween(from: Date, to: Date): string[] {
  const days: string[] = [];
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  for (
    let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    t <= end && days.length < MAX_RANGE_DAYS;
    t += DAY_MS
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

function parseRange(searchParams: URLSearchParams): { from: Date; to: Date } | { error: string } {
  const to = searchParams.get("end_before")
    ? parseISO(searchParams.get("end_before")!)
    : new Date();
  const from = searchParams.get("start_after")
    ? parseISO(searchParams.get("start_after")!)
    : new Date(to.getTime() - 7 * DAY_MS);
  if (!isValid(to) || !isValid(from)) {
    return { error: "start_after and end_before must be ISO timestamps" };
  }
  if (from.getTime() >= to.getTime()) return { error: "start_after must be before end_before" };
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    return { error: `The range must not exceed ${MAX_RANGE_DAYS} days` };
  }
  return { from, to };
}

interface BackendOverview {
  fit: { fit_id: string; fitted_at_ms: number } | null;
  sampled: number;
  ungrouped: number;
  digests_in_window: number;
  groups: {
    group_id: string;
    name: string;
    description: string;
    count: number;
    trend: { day: string; count: number }[];
  }[];
}

// GET /api/projects/[projectId]/task-groups?start_after=&end_before=
export async function handleOverview(req: NextRequest, { params }: Params<{ projectId: string }>) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  const range = parseRange(req.nextUrl.searchParams);
  if ("error" in range) return errorResponse(range.error, 400);

  const workspace = await prisma.workspace.findUnique({
    where: { id: auth.project.workspaceId },
    select: { billingPlan: true },
  });
  const from = new Date(
    clampStartAfter(workspace?.billingPlan ?? PlanType.FREE, range.from.toISOString())!,
  );
  const to = range.to;
  const now = Date.now();

  let overview: BackendOverview;
  try {
    overview = await backendGet<BackendOverview>(
      "/overview",
      new URLSearchParams({
        project_id: projectId,
        since_ms: String(Math.min(from.getTime(), to.getTime() - 1)),
        until_ms: String(to.getTime()),
        window_since_ms: String(now - FIT_WINDOW_DAYS * DAY_MS),
      }),
    );
  } catch {
    return errorResponse("Could not load topics", 502);
  }

  const state = await readTaskGroupState(prisma, {
    projectId,
    keyConfigured: signalsKeyConfigured(),
    groupsExist: overview.fit !== null,
  });
  const settings = await prisma.taskGroupSettings.findUnique({
    where: { projectId },
    select: { refreshRequestedAt: true },
  });
  const nextRefresh = settings?.refreshRequestedAt
    ? settings.refreshRequestedAt.getTime() + REFRESH_MIN_INTERVAL_MS
    : null;

  const sampled = overview.sampled;
  const groups: TaskGroupRow[] = overview.groups
    .map((g) => ({
      groupId: g.group_id,
      name: g.name,
      description: g.description,
      count: g.count,
      share: sampled > 0 ? g.count / sampled : 0,
      trend: g.trend,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const body: TaskGroupsOverview = {
    state: { ...state, keyConfigured: signalsKeyConfigured() },
    minDigests: MIN_DIGESTS_FOR_GROUPS,
    digestsInWindow: overview.digests_in_window,
    sampled,
    ungrouped: overview.ungrouped,
    fittedAt: overview.fit ? new Date(overview.fit.fitted_at_ms).toISOString() : null,
    groups,
    days: daysBetween(from, to),
    refreshAvailableAt:
      nextRefresh && nextRefresh > now ? new Date(nextRefresh).toISOString() : null,
  };
  return successResponse(body);
}

const settingsBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    dailyCostCapUsd: z.number().min(0.01).max(1000).optional(),
  })
  .refine((b) => b.enabled !== undefined || b.dailyCostCapUsd !== undefined, {
    message: "Nothing to change",
  });

// PUT /api/projects/[projectId]/task-groups/settings { enabled?, dailyCostCapUsd? }
export async function handleUpdateSettings(
  req: NextRequest,
  { params }: Params<{ projectId: string }>,
) {
  const { projectId } = await params;
  const auth = await authorize(projectId, Role.MEMBER);
  if (auth.error) return auth.error;
  if (isDemoViewer(auth.project.workspaceId, auth.membership.role)) {
    return errorResponse(DEMO_VIEWER_FORBIDDEN, 403);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const body = settingsBodySchema.safeParse(json);
  if (!body.success) return errorResponse(body.error.issues[0].message, 400);
  const row = await prisma.taskGroupSettings.upsert({
    where: { projectId },
    create: {
      projectId,
      enabled: body.data.enabled ?? false,
      ...(body.data.dailyCostCapUsd !== undefined && {
        dailyCostCapUsd: body.data.dailyCostCapUsd,
      }),
    },
    update: {
      ...(body.data.enabled !== undefined && { enabled: body.data.enabled }),
      ...(body.data.dailyCostCapUsd !== undefined && {
        dailyCostCapUsd: body.data.dailyCostCapUsd,
      }),
      updateTime: new Date(),
    },
    select: { enabled: true, dailyCostCapUsd: true },
  });
  return successResponse(row);
}

// POST /api/projects/[projectId]/task-groups/refresh
export async function handleRefresh(_req: NextRequest, { params }: Params<{ projectId: string }>) {
  const { projectId } = await params;
  const auth = await authorize(projectId, Role.MEMBER);
  if (auth.error) return auth.error;
  if (isDemoViewer(auth.project.workspaceId, auth.membership.role)) {
    return errorResponse(DEMO_VIEWER_FORBIDDEN, 403);
  }
  const result = await requestTaskGroupRefresh(prisma, projectId);
  if (result.accepted) return successResponse({ accepted: true }, 202);
  return Response.json(
    {
      error: result.nextAllowedAt
        ? "Refresh was asked for recently"
        : "Topics are off for this project",
      nextAllowedAt: result.nextAllowedAt?.toISOString() ?? null,
    },
    { status: result.nextAllowedAt ? 429 : 409 },
  );
}

// GET /api/projects/[projectId]/task-groups/by-trace?trace_id=...&trace_id=...
export async function handleByTrace(req: NextRequest, { params }: Params<{ projectId: string }>) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if (auth.error) return auth.error;
  const traceIds = [...new Set(req.nextUrl.searchParams.getAll("trace_id").filter(Boolean))];
  if (traceIds.length > MAX_BY_TRACE_IDS) {
    return errorResponse(`at most ${MAX_BY_TRACE_IDS} trace_id values`, 400);
  }
  if (traceIds.length === 0) return successResponse({ groups: {} });
  const query = new URLSearchParams([
    ["project_id", projectId],
    ...traceIds.map((id) => ["trace_id", id]),
  ]);
  try {
    const res = await backendGet<{ data: Record<string, { group_id: string; name: string }> }>(
      "/by-trace",
      query,
    );
    return successResponse({
      groups: Object.fromEntries(
        Object.entries(res.data).map(([traceId, g]) => [
          traceId,
          { groupId: g.group_id, name: g.name },
        ]),
      ),
    });
  } catch {
    return errorResponse("Could not load topics", 502);
  }
}
