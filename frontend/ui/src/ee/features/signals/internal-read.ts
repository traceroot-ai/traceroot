/**
 * POST /api/internal/project-signals — the read behind the public `list_signals`
 * and `get_signal` routes. The Python backend has already resolved the project
 * from an authenticated credential; trust is the X-Internal-Secret plus that
 * resolved project id. Lookups are scoped through the project id, so a signal
 * in another project simply isn't found (404). Never log ids.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { SIGNAL_STATUSES, listSignals } from "@traceroot/core/signals";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// `skip` is a 32-bit int in Prisma; at MAX_LIMIT this is still far more pages
// than a project holds signals.
const MAX_PAGE = 10_000;

const bodySchema = z.object({
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  // Present: fetch that one signal. Absent: list the project's signals.
  signalId: z.string("signalId must be a string").min(1, "signalId must be a string").optional(),
  status: z.enum(SIGNAL_STATUSES).optional(),
  detectorId: z.string().min(1).optional(),
  limit: z.number().int().optional(),
  page: z.number().int().optional(),
});

type ListedSignal = Awaited<ReturnType<typeof listSignals>>["signals"][number];

function serializeListed(s: ListedSignal) {
  return {
    id: s.id,
    detectorId: s.detectorId,
    detectorName: s.detectorName,
    title: s.title,
    status: s.status,
    hitCount: s.hitCount,
    reopenCount: s.reopenSeq,
    firstSeenAt: s.firstSeenAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    createTime: s.createTime.toISOString(),
    rcaState: s.rca.currentState,
  };
}

async function readOne(projectId: string, signalId: string) {
  const signal = await prisma.signal.findFirst({
    where: { id: signalId, projectId },
    select: {
      id: true,
      detectorId: true,
      title: true,
      status: true,
      hitCount: true,
      reopenSeq: true,
      firstSeenAt: true,
      lastSeenAt: true,
      createTime: true,
      resolvedAt: true,
      mergedIntoId: true,
      rcas: { select: { reopenSeq: true, rca: { select: { status: true } } } },
    },
  });
  if (!signal) return null;
  // Signals keep no relation to detectors (a detector can be deleted first).
  const detector = await prisma.detector.findFirst({
    where: { id: signal.detectorId, projectId },
    select: { name: true },
  });
  return {
    id: signal.id,
    detectorId: signal.detectorId,
    detectorName: detector?.name ?? null,
    title: signal.title,
    status: signal.status,
    hitCount: signal.hitCount,
    reopenCount: signal.reopenSeq,
    firstSeenAt: signal.firstSeenAt.toISOString(),
    lastSeenAt: signal.lastSeenAt.toISOString(),
    createTime: signal.createTime.toISOString(),
    resolvedAt: signal.resolvedAt ? signal.resolvedAt.toISOString() : null,
    // A merged signal is still answered, so a caller holding its id learns where
    // its hits went; the list leaves merged signals out.
    mergedIntoId: signal.mergedIntoId,
    rcaState:
      signal.rcas.find((opening) => opening.reopenSeq === signal.reopenSeq)?.rca.status ?? null,
  };
}

export async function handleInternalSignalRead(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { projectId, signalId } = parsed.data;

  if (signalId !== undefined) {
    const signal = await readOne(projectId, signalId);
    if (!signal) return NextResponse.json({ error: "Signal not found" }, { status: 404 });
    return NextResponse.json({ signal });
  }

  // Clamped rather than rejected: the public layer validates the ranges it documents.
  const limit = Math.min(Math.max(parsed.data.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const page = Math.min(Math.max(parsed.data.page ?? 0, 0), MAX_PAGE);
  const { signals, total } = await listSignals(prisma, {
    projectId,
    detectorIds: parsed.data.detectorId ? [parsed.data.detectorId] : undefined,
    statuses: parsed.data.status ? [parsed.data.status] : undefined,
    page,
    limit,
  });
  return NextResponse.json({
    signals: signals.map(serializeListed),
    meta: { page, limit, total },
  });
}
