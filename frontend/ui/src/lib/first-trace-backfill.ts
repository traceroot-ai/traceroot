/**
 * The first-trace time of projects that already had traces when this deployment
 * started recording first traces.
 *
 * `first_trace_receive_time` is written when the ingest worker reports a
 * project's traces (lib/trace-activity.ts). The first report this deployment ever
 * receives marks when that recording started (`first_trace_tracking`). A project
 * whose earliest stored trace was received before that moment already had traces:
 * its time is filled from the trace store, quietly, without any event. A project
 * whose earliest trace came after it is receiving its first trace, which the
 * worker's report records, with `first_trace_received`.
 *
 * Nothing runs as a separate backfill, on our cloud or on a self-hosted install:
 * a project is filled the first time its first-trace time is read, or the first
 * time the worker reports its traces after the start.
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

/** When this deployment started recording first traces; null before its first report. */
export async function firstTraceTrackingStart(): Promise<Date | null> {
  const row = await prisma.firstTraceTracking.findUnique({
    where: { id: 1 },
    select: { startedAt: true },
  });
  return row?.startedAt ?? null;
}

/**
 * The start of first-trace recording, set to `now` by the first call that finds
 * none. Concurrent first calls agree on one start.
 */
export async function startFirstTraceTracking(now: Date): Promise<Date> {
  const existing = await firstTraceTrackingStart();
  if (existing) return existing;
  try {
    const created = await prisma.firstTraceTracking.create({ data: { id: 1, startedAt: now } });
    return created.startedAt;
  } catch (err) {
    if (!isPrismaKnownError(err, "P2002")) throw err;
  }
  // Another report started it a moment ago.
  return (await firstTraceTrackingStart()) ?? now;
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
 * Only a trace from before recording started is stored here. A later one is
 * returned without being stored, so the worker's report still records it as the
 * project's first, with its event.
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
  if (trackingStart && receivedAt >= trackingStart) return receivedAt;
  return fillFirstTraceReceiveTime(project.id, receivedAt);
}
