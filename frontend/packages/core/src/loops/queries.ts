/** Loop reads and their JSON shapes: the list with its roll-ups, one Loop, its runs, and memory. */
import type { Loop, LoopRun, Prisma } from "@prisma/client";
import {
  COUNTED_RUN_STATUSES,
  type LoopDto,
  type LoopMemoryDto,
  type LoopRunDto,
  type LoopRunStatus,
  type LoopRunTrigger,
  type LoopStatus,
  type LoopSummaryDto,
  type Paged,
} from "./contracts.ts";
import { findingKeyOfGroupKey } from "./keys.ts";
import { scheduleFromColumns } from "./schedule.ts";

type Db = Prisma.TransactionClient;

export function loopToDto(loop: Loop): LoopDto {
  return {
    id: loop.id,
    projectId: loop.projectId,
    detectorId: loop.detectorId,
    name: loop.name,
    template: loop.template,
    instructions: loop.instructions,
    schedule: scheduleFromColumns(loop),
    status: loop.status as LoopStatus,
    dryRun: loop.dryRun,
    model: loop.model,
    provider: loop.provider,
    source: loop.source as "system" | "byok" | null,
    lookbackHours: loop.lookbackHours,
    nextRunAt: loop.nextRunAt?.toISOString() ?? null,
    lastRunAt: loop.lastRunAt?.toISOString() ?? null,
    failureStreak: loop.failureStreak,
    createdBy: loop.createdBy,
    createTime: loop.createTime.toISOString(),
    updateTime: loop.updateTime.toISOString(),
  };
}

export function runToDto(run: LoopRun): LoopRunDto {
  return {
    id: run.id,
    loopId: run.loopId,
    seq: run.seq,
    trigger: run.trigger as LoopRunTrigger,
    slotAt: run.slotAt?.toISOString() ?? null,
    status: run.status as LoopRunStatus,
    attempts: run.attempts,
    sessionId: run.sessionId,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    summary: run.summary,
    findingKeys: run.findingKeys,
    tracesRead: run.tracesRead,
    error: run.error,
    metadata: (run.metadata as Record<string, unknown> | null) ?? null,
    costUsd: run.costUsd === null ? null : Number(run.costUsd),
    createTime: run.createTime.toISOString(),
  };
}

/**
 * Attach each Loop's last run, run count, mean cost and signal count. The last
 * run is one indexed lookup per Loop (a project has at most five), so the read
 * never scans a Loop's whole run history.
 */
async function summarize(db: Db, loops: Loop[]): Promise<LoopSummaryDto[]> {
  if (loops.length === 0) return [];
  const loopIds = loops.map((l) => l.id);
  const detectorIds = loops.map((l) => l.detectorId);
  const [lastRuns, counted, signals] = await Promise.all([
    Promise.all(
      loopIds.map((loopId) =>
        db.loopRun.findFirst({ where: { loopId }, orderBy: { seq: "desc" } }),
      ),
    ),
    db.loopRun.groupBy({
      by: ["loopId"],
      where: { loopId: { in: loopIds }, status: { in: [...COUNTED_RUN_STATUSES] } },
      _count: { _all: true },
      _avg: { costUsd: true },
    }),
    db.signal.groupBy({
      by: ["detectorId"],
      where: { detectorId: { in: detectorIds }, mergedIntoId: null },
      _count: { _all: true },
    }),
  ]);
  const lastByLoop = new Map(lastRuns.flatMap((r) => (r ? [[r.loopId, r] as const] : [])));
  const countedByLoop = new Map(counted.map((c) => [c.loopId, c]));
  const signalsByDetector = new Map(signals.map((s) => [s.detectorId, s._count._all]));
  return loops.map((loop) => {
    const last = lastByLoop.get(loop.id);
    const stats = countedByLoop.get(loop.id);
    const avg = stats?._avg.costUsd;
    return {
      ...loopToDto(loop),
      lastRun: last ? runToDto(last) : null,
      runCount: stats?._count._all ?? 0,
      avgCostUsd: avg === null || avg === undefined ? null : Number(avg),
      signalCount: signalsByDetector.get(loop.detectorId) ?? 0,
    };
  });
}

export async function listLoops(
  db: Db,
  input: { projectId: string; search?: string | null; page: number; limit: number },
): Promise<Paged<LoopSummaryDto>> {
  const where: Prisma.LoopWhereInput = {
    projectId: input.projectId,
    ...(input.search ? { name: { contains: input.search, mode: "insensitive" as const } } : {}),
  };
  const [loops, total] = await Promise.all([
    db.loop.findMany({
      where,
      orderBy: { createTime: "asc" },
      skip: input.page * input.limit,
      take: input.limit,
    }),
    db.loop.count({ where }),
  ]);
  return {
    data: await summarize(db, loops),
    meta: { page: input.page, limit: input.limit, total },
  };
}

export async function getLoopSummary(
  db: Db,
  projectId: string,
  loopId: string,
): Promise<LoopSummaryDto | null> {
  const loop = await db.loop.findFirst({ where: { id: loopId, projectId } });
  if (!loop) return null;
  return (await summarize(db, [loop]))[0];
}

/**
 * A Loop's runs, newest first. `status` narrows to one outcome; `signalId` to
 * the runs that recorded that signal's finding, and to none when the signal is
 * not one of this Loop's.
 */
export async function listLoopRuns(
  db: Db,
  input: {
    projectId: string;
    loop: { id: string; detectorId: string };
    page: number;
    limit: number;
    status?: LoopRunStatus | null;
    signalId?: string | null;
  },
): Promise<Paged<LoopRunDto>> {
  const { page, limit } = input;
  let findingKey: string | null = null;
  if (input.signalId) {
    const signal = await db.signal.findFirst({
      where: { id: input.signalId, projectId: input.projectId, detectorId: input.loop.detectorId },
      select: { groupKey: true },
    });
    findingKey = findingKeyOfGroupKey(signal?.groupKey ?? null);
    if (!findingKey) return { data: [], meta: { page, limit, total: 0 } };
  }
  const where: Prisma.LoopRunWhereInput = {
    loopId: input.loop.id,
    ...(input.status ? { status: input.status } : {}),
    ...(findingKey ? { findingKeys: { has: findingKey } } : {}),
  };
  const [runs, total] = await Promise.all([
    db.loopRun.findMany({
      where,
      orderBy: { seq: "desc" },
      skip: page * limit,
      take: limit,
    }),
    db.loopRun.count({ where }),
  ]);
  return { data: runs.map(runToDto), meta: { page, limit, total } };
}

export async function getLoopRun(
  db: Db,
  loopId: string,
  runId: string,
): Promise<LoopRunDto | null> {
  const run = await db.loopRun.findFirst({ where: { id: runId, loopId } });
  return run ? runToDto(run) : null;
}

export function isExpired(memory: { expiresAt: Date | null }, now: Date): boolean {
  return memory.expiresAt !== null && memory.expiresAt.getTime() <= now.getTime();
}

/**
 * The project's memory notes, newest first; every note is shared by the
 * project's Loops. Expired ones are hidden unless asked for.
 */
export async function listMemory(
  db: Db,
  input: { projectId: string; now: Date; includeExpired?: boolean },
): Promise<LoopMemoryDto[]> {
  const rows = await db.loopMemory.findMany({
    where: { projectId: input.projectId },
    include: { loop: { select: { name: true } } },
    orderBy: { updateTime: "desc" },
  });
  return rows
    .map((row) => ({
      id: row.id,
      loopId: row.loopId,
      loopName: row.loop?.name ?? null,
      key: row.key,
      content: row.content,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: isExpired(row, input.now),
      updatedByRunId: row.updatedByRunId,
      updateTime: row.updateTime.toISOString(),
    }))
    .filter((memory) => input.includeExpired || !memory.expired);
}
