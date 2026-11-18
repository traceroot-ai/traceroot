/**
 * The first-trace time of projects that already had traces when the ingest worker
 * started reporting trace activity.
 *
 * `first_trace_receive_time` is written when the worker reports a project's traces
 * (lib/trace-activity.ts). Before its first report, and as it starts, the worker
 * records when it started reporting (`POST /api/internal/first-trace-tracking`,
 * kept in `first_trace_tracking`): the cutoff. Only the first start recorded is
 * kept. A project whose earliest stored customer trace was received before the
 * cutoff already had traces: its time is filled from the trace store, quietly,
 * without any event. A project whose earliest trace came after it is receiving its
 * first trace, which the worker's report records, with `first_trace_received`.
 * Until a cutoff is recorded nothing is decided either way.
 *
 * Nothing runs as a separate backfill, on our cloud or on a self-hosted install:
 * a project is filled the first time its first-trace time is read, or the first
 * time the worker reports its traces after the cutoff.
 */
import { prisma } from "@traceroot/core";
import { env } from "@/env";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

/** When the project's earliest stored customer span was received, from the trace store; null when it has none. */
export async function readFirstTraceReceiveTime(projectId: string): Promise<Date | null> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/internal/projects/${encodeURIComponent(projectId)}/first-trace`,
    { headers: { "X-Internal-Secret": env.INTERNAL_API_SECRET }, cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`first-trace lookup failed with status ${response.status}`);
  }
  const body = (await response.json()) as { first_trace_receive_time: string | null };
  return body.first_trace_receive_time ? new Date(body.first_trace_receive_time) : null;
}

/** When the ingest worker started reporting (the cutoff); null until it has recorded it. */
export async function firstTraceTrackingStart(): Promise<Date | null> {
  const row = await prisma.firstTraceTracking.findUnique({
    where: { id: 1 },
    select: { startedAt: true },
  });
  return row?.startedAt ?? null;
}

/**
 * Records `startedAt`, when the ingest worker started reporting, as the cutoff
 * unless one is already recorded, and returns the recorded cutoff. A recorded
 * cutoff is never moved. Concurrent first calls agree on one.
 */
export async function startFirstTraceTracking(startedAt: Date): Promise<Date> {
  const existing = await firstTraceTrackingStart();
  if (existing) return existing;
  try {
    const created = await prisma.firstTraceTracking.create({ data: { id: 1, startedAt } });
    return created.startedAt;
  } catch (err) {
    if (!isPrismaKnownError(err, "P2002")) throw err;
  }
  // Another worker recorded its start a moment ago.
  return (await firstTraceTrackingStart()) ?? startedAt;
}

/**
 * Fills an empty first-trace time with `receivedAt` and returns what is stored
 * afterwards. A report that recorded the first trace in the meantime keeps its
 * value. Sends nothing.
 */
export async function fillFirstTraceReceiveTime(
  projectId: string,
  receivedAt: Date,
): Promise<Date | null> {
  await prisma.project.updateMany({
    where: { id: projectId, firstTraceReceiveTime: null },
    data: { firstTraceReceiveTime: receivedAt },
  });
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { firstTraceReceiveTime: true },
  });
  return project?.firstTraceReceiveTime ?? null;
}

/**
 * When the project first received a trace, for reading: the recorded time, or
 * else the trace store's. Null while the project has no traces, and for the
 * shared demo workspace, which is nobody's first trace.
 *
 * Only a trace from before the cutoff is stored here. A later one, and any trace
 * while no cutoff is recorded, is returned without being stored, so the worker's
 * report still decides, with the event for a project's first trace.
 */
export async function resolveFirstTraceReceiveTime(project: {
  id: string;
  workspaceId: string;
  firstTraceReceiveTime: Date | null;
}): Promise<Date | null> {
  if (project.firstTraceReceiveTime) return project.firstTraceReceiveTime;
  if (isDemoWorkspace(project.workspaceId)) return null;

  const receivedAt = await readFirstTraceReceiveTime(project.id);
  if (!receivedAt) return null;
  const trackingStart = await firstTraceTrackingStart();
  if (!trackingStart || receivedAt >= trackingStart) return receivedAt;
  return fillFirstTraceReceiveTime(project.id, receivedAt);
}
