import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import {
  DEFAULT_UPDATE_SCHEDULE,
  nextSlotAfter,
  parseScheduleInput,
  type UpdateScheduleSettings,
} from "@traceroot/core/updates";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { DEMO_VIEWER_FORBIDDEN, isDemoViewer } from "@/lib/demo-workspace";

type RouteParams = { params: Promise<{ projectId: string }> };

function serialize(settings: UpdateScheduleSettings, configured: boolean) {
  return {
    configured,
    enabled: settings.enabled,
    frequency: settings.frequency,
    weekday: settings.weekday,
    hour: settings.hour,
    timezone: settings.timezone,
  };
}

// GET /api/projects/[projectId]/update-schedule
// The project's update schedule, or the defaults (not yet saved) when it has none,
// with the status of its latest run.
async function handleGET(_request: NextRequest, { params }: RouteParams) {
  const { projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const [row, lastRun] = await Promise.all([
    prisma.projectUpdateSchedule.findUnique({ where: { projectId } }),
    prisma.projectUpdateRun.findFirst({
      where: { projectId },
      orderBy: { slotAt: "desc" },
      select: {
        id: true,
        status: true,
        trigger: true,
        slotAt: true,
        finishedAt: true,
        error: true,
      },
    }),
  ]);

  const settings: UpdateScheduleSettings = row
    ? {
        enabled: row.enabled,
        frequency: row.frequency as UpdateScheduleSettings["frequency"],
        weekday: row.weekday,
        hour: row.hour,
        timezone: row.timezone,
      }
    : { ...DEFAULT_UPDATE_SCHEDULE, enabled: false };

  return successResponse({
    ...serialize(settings, row !== null),
    next_slot_at: row?.nextSlotAt ?? null,
    last_run: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          trigger: lastRun.trigger,
          slot_at: lastRun.slotAt,
          finished_at: lastRun.finishedAt,
          error: lastRun.error,
        }
      : null,
  });
}

// PUT /api/projects/[projectId]/update-schedule (MEMBER+)
// Save the schedule. Anything more frequent than daily is rejected.
async function handlePUT(request: NextRequest, { params }: RouteParams) {
  const { projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;
  if (isDemoViewer(accessResult.project.workspaceId, accessResult.membership.role)) {
    return errorResponse(DEMO_VIEWER_FORBIDDEN, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("The body must be JSON.", 400);
  }
  // A client sends only what it changes: the rest keeps its saved value (or the default).
  const saved = await prisma.projectUpdateSchedule.findUnique({ where: { projectId } });
  const base: Record<string, unknown> = saved
    ? {
        enabled: saved.enabled,
        frequency: saved.frequency,
        weekday: saved.weekday,
        hour: saved.hour,
        timezone: saved.timezone,
      }
    : {};
  const parsed = parseScheduleInput(
    typeof body === "object" && body !== null && !Array.isArray(body) ? { ...base, ...body } : body,
  );
  if (!parsed.ok) return errorResponse(parsed.error, 400);
  const settings = parsed.value;

  // The next slot is the first one after now: saving never starts a run for a slot
  // that has already passed.
  const nextSlotAt = settings.enabled ? nextSlotAfter(settings, new Date()) : null;
  const stored = await prisma.projectUpdateSchedule.upsert({
    where: { projectId },
    create: { projectId, ...settings, nextSlotAt },
    update: { ...settings, nextSlotAt },
  });

  return successResponse({ ...serialize(settings, true), next_slot_at: stored.nextSlotAt });
}

export const GET = withImpersonationPolicy(handleGET);
export const PUT = withImpersonationPolicy(handlePUT);
