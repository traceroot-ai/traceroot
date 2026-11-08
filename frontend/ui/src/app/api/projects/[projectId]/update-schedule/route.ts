import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import {
  DEFAULT_UPDATE_LIMITS,
  DEFAULT_UPDATE_SCHEDULE,
  nextSlotAfter,
  parseCodeSettingsInput,
  parseLimitsInput,
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
      orderBy: { createTime: "desc" },
      select: {
        id: true,
        status: true,
        trigger: true,
        slotAt: true,
        finishedAt: true,
        error: true,
        stopReason: true,
        deliveryNote: true,
        skillsRan: true,
        tokensIn: true,
        tokensOut: true,
        costUsd: true,
        slackDeliveredAt: true,
        emailDeliveredAt: true,
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
    code_changes_enabled: row?.codeChangesEnabled ?? false,
    code_repos: row?.codeRepos ?? [],
    run_token_cap: row?.runTokenCap ?? DEFAULT_UPDATE_LIMITS.runTokenCap,
    monthly_spend_cap_usd: row?.monthlySpendCapUsd ?? DEFAULT_UPDATE_LIMITS.monthlySpendCapUsd,
    last_run: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          trigger: lastRun.trigger,
          slot_at: lastRun.slotAt,
          finished_at: lastRun.finishedAt,
          error: lastRun.error,
          stop_reason: lastRun.stopReason,
          delivery_note: lastRun.deliveryNote,
          skills_ran: Array.isArray(lastRun.skillsRan) ? lastRun.skillsRan : [],
          tokens: lastRun.tokensIn + lastRun.tokensOut,
          cost_usd: lastRun.costUsd,
          slack_delivered: lastRun.slackDeliveredAt !== null,
          email_delivered: lastRun.emailDeliveredAt !== null,
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
  const limits = parseLimitsInput(
    body,
    saved
      ? { runTokenCap: saved.runTokenCap, monthlySpendCapUsd: saved.monthlySpendCapUsd }
      : undefined,
  );
  if (!limits.ok) return errorResponse(limits.error, 400);
  const code = parseCodeSettingsInput(
    body,
    saved
      ? { codeChangesEnabled: saved.codeChangesEnabled, codeRepos: saved.codeRepos }
      : undefined,
  );
  if (!code.ok) return errorResponse(code.error, 400);

  // The next slot is the first one after now: saving never starts a run for a slot
  // that has already passed.
  const nextSlotAt = settings.enabled ? nextSlotAfter(settings, new Date()) : null;
  const stored = await prisma.projectUpdateSchedule.upsert({
    where: { projectId },
    create: { projectId, ...settings, ...limits.value, ...code.value, nextSlotAt },
    update: { ...settings, ...limits.value, ...code.value, nextSlotAt },
  });

  return successResponse({
    ...serialize(settings, true),
    next_slot_at: stored.nextSlotAt,
    code_changes_enabled: stored.codeChangesEnabled,
    code_repos: stored.codeRepos,
    run_token_cap: stored.runTokenCap,
    monthly_spend_cap_usd: stored.monthlySpendCapUsd,
  });
}

export const GET = withImpersonationPolicy(handleGET);
export const PUT = withImpersonationPolicy(handlePUT);
