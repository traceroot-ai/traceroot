/**
 * What a project's incoming traces tell us about its owner, recorded each time
 * the ingest worker reports that the project received traces
 * (`POST /api/internal/trace-activity`).
 *
 * Three facts, each written so that the same report arriving twice (a retry, or
 * two worker replicas) changes nothing the second time:
 *
 * - The project's first trace. `first_trace_receive_time` is set only while it is
 *   empty, and `first_trace_received` is sent only by the call whose update filled
 *   it, so a project sends the event once.
 * - The days in the owner's first week on which traces arrived. A UTC day counts
 *   once, on the first report that day from any of the owner's projects. The week
 *   is the owner's sign-up day and the six days after it.
 * - An active first week, `active_first_week`: sent once, by the call that finds
 *   the threshold reached and marks it.
 *
 * The owner is the person who created the workspace, or its earliest admin for
 * workspaces older than `Workspace.createdBy`. Projects in the shared demo
 * workspace record nothing: everyone is a member of it and nobody set it up.
 */
import { prisma, Role } from "@traceroot/core";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { captureServerEvent } from "@/lib/posthog-server";
import { utcDay } from "@/lib/utc-day";

/** Days with traces in the owner's first week that make it an active first week. */
export const ACTIVE_FIRST_WEEK_DAYS = 3;

const FIRST_WEEK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TraceActivityOutcome =
  | { kind: "unknown_project" }
  | { kind: "demo_project" }
  | {
      kind: "recorded";
      /** This call recorded the project's first trace. */
      firstTrace: boolean;
      /** This call counted today toward the owner's first week. */
      activeDayCounted: boolean;
      /** This call marked the owner's first week as active. */
      activeFirstWeek: boolean;
    };

export async function recordTraceActivity(
  projectId: string,
  now: Date = new Date(),
): Promise<TraceActivityOutcome> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deleteTime: null },
    select: { workspaceId: true, workspace: { select: { createdBy: true } } },
  });
  if (!project) return { kind: "unknown_project" };
  if (isDemoWorkspace(project.workspaceId)) return { kind: "demo_project" };

  const ownerId = project.workspace.createdBy ?? (await earliestAdmin(project.workspaceId));
  const properties = { project_id: projectId, workspace_id: project.workspaceId };

  const firstTrace = await markFirstTrace(projectId, now);
  if (firstTrace && ownerId) captureServerEvent(ownerId, "first_trace_received", properties);

  const week = ownerId ? await countFirstWeekDay(ownerId, now) : { counted: false, active: false };
  if (week.active && ownerId) captureServerEvent(ownerId, "active_first_week", properties);

  return {
    kind: "recorded",
    firstTrace,
    activeDayCounted: week.counted,
    activeFirstWeek: week.active,
  };
}

/** Fills the project's first-trace time if it is still empty; true when this call filled it. */
async function markFirstTrace(projectId: string, now: Date): Promise<boolean> {
  const { count } = await prisma.project.updateMany({
    where: { id: projectId, firstTraceReceiveTime: null },
    data: { firstTraceReceiveTime: now },
  });
  return count === 1;
}

async function earliestAdmin(workspaceId: string): Promise<string | null> {
  const admin = await prisma.workspaceMember.findFirst({
    where: { workspaceId, role: Role.ADMIN },
    orderBy: { createTime: "asc" },
    select: { userId: true },
  });
  return admin?.userId ?? null;
}

async function countFirstWeekDay(
  userId: string,
  now: Date,
): Promise<{ counted: boolean; active: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
  if (!user) return { counted: false, active: false };

  const today = utcDay(now);
  const dayOfWeek = Math.round((today.getTime() - utcDay(user.createdAt).getTime()) / DAY_MS);
  if (dayOfWeek < 0 || dayOfWeek >= FIRST_WEEK_DAYS) return { counted: false, active: false };

  const counted = await countDay(userId, today);
  // Tried on every report in the week, not only the one that counted the third
  // day, so a call that stopped between the two writes is finished by the next.
  const { count } = await prisma.userOnboarding.updateMany({
    where: { userId, activeWeekAt: null, activeDaysFirstWeek: { gte: ACTIVE_FIRST_WEEK_DAYS } },
    data: { activeWeekAt: now },
  });
  return { counted, active: count === 1 };
}

/** Counts `today` for the user unless it is already counted; true when this call counted it. */
async function countDay(userId: string, today: Date): Promise<boolean> {
  const notCountedToday = {
    userId,
    OR: [{ lastActiveDay: null }, { lastActiveDay: { lt: today } }],
  };
  const countToday = { lastActiveDay: today, activeDaysFirstWeek: { increment: 1 } };

  if (
    (await prisma.userOnboarding.updateMany({ where: notCountedToday, data: countToday })).count
  ) {
    return true;
  }
  try {
    await prisma.userOnboarding.create({
      data: { userId, lastActiveDay: today, activeDaysFirstWeek: 1 },
    });
    return true;
  } catch (err) {
    if (!isPrismaKnownError(err, "P2002")) throw err;
  }
  // The row exists: either today is already counted, or another report created
  // the row a moment ago. The conditional update tells the two apart.
  const { count } = await prisma.userOnboarding.updateMany({
    where: notCountedToday,
    data: countToday,
  });
  return count === 1;
}
