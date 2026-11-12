/** Reads for the Loops pages: the list with its roll-ups, one Loop, its runs and its findings. */
import type { Loop, Prisma } from "@prisma/client";
import {
  COUNTED_RUN_STATUSES,
  type LoopDto,
  type LoopFindingDto,
  type LoopPauseReason,
  type LoopStatus,
  type LoopSummaryDto,
  type Paged,
  type LoopRunDto,
  type LoopRunStatus,
} from "./contracts.ts";
import { scheduleFromColumns } from "./schedule.ts";
import { runToDto } from "./runs.ts";

type Db = Prisma.TransactionClient;

export function loopToDto(loop: Loop): LoopDto {
  return {
    id: loop.id,
    projectId: loop.projectId,
    detectorId: loop.detectorId,
    name: loop.name,
    template: loop.template,
    instructions: loop.instructions,
    templateVersion: loop.templateVersion,
    schedule: scheduleFromColumns(loop),
    status: loop.status as LoopStatus,
    pauseReason: loop.pauseReason as LoopPauseReason | null,
    statusChangedAt: loop.statusChangedAt.toISOString(),
    statusChangedBy: loop.statusChangedBy,
    dryRun: loop.dryRun,
    precheckSql: loop.precheckSql,
    lastPrecheckAt: loop.lastPrecheckAt?.toISOString() ?? null,
    lastPrecheckOutcome: loop.lastPrecheckOutcome,
    model: loop.model,
    provider: loop.provider,
    source: loop.source as "system" | "byok" | null,
    maxFindingsPerRun: loop.maxFindingsPerRun,
    lookbackHours: loop.lookbackHours,
    nextRunAt: loop.nextRunAt?.toISOString() ?? null,
    lastRunAt: loop.lastRunAt?.toISOString() ?? null,
    failureStreak: loop.failureStreak,
    createdBy: loop.createdBy,
    createTime: loop.createTime.toISOString(),
    updateTime: loop.updateTime.toISOString(),
  };
}

/** Attach each Loop's last run, run count, mean cost and signal count: four queries, however many Loops. */
async function summarize(db: Db, loops: Loop[]): Promise<LoopSummaryDto[]> {
  if (loops.length === 0) return [];
  const loopIds = loops.map((l) => l.id);
  const detectorIds = loops.map((l) => l.detectorId);
  const [lastRuns, counted, signals] = await Promise.all([
    db.loopRun.findMany({
      where: { loopId: { in: loopIds } },
      orderBy: [{ loopId: "asc" }, { seq: "desc" }],
      distinct: ["loopId"],
    }),
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
  const lastByLoop = new Map(lastRuns.map((r) => [r.loopId, r]));
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

export async function listLoopRuns(
  db: Db,
  input: {
    loopId: string;
    page: number;
    limit: number;
    status?: LoopRunStatus | null;
  },
): Promise<Paged<LoopRunDto>> {
  const where: Prisma.LoopRunWhereInput = {
    loopId: input.loopId,
    ...(input.status ? { status: input.status } : {}),
  };
  const [runs, total] = await Promise.all([
    db.loopRun.findMany({
      where,
      orderBy: { seq: "desc" },
      skip: input.page * input.limit,
      take: input.limit,
    }),
    db.loopRun.count({ where }),
  ]);
  return {
    data: runs.map(runToDto),
    meta: { page: input.page, limit: input.limit, total },
  };
}

export async function getLoopRun(
  db: Db,
  loopId: string,
  runId: string,
): Promise<LoopRunDto | null> {
  const run = await db.loopRun.findFirst({ where: { id: runId, loopId } });
  return run ? runToDto(run) : null;
}

/** The signals the Loop created: signals of its hidden detector, merged ones folded into their target. */
export async function listLoopFindings(
  db: Db,
  input: { detectorId: string; projectId: string; page: number; limit: number },
): Promise<Paged<LoopFindingDto>> {
  const where: Prisma.SignalWhereInput = {
    projectId: input.projectId,
    detectorId: input.detectorId,
    mergedIntoId: null,
  };
  const [signals, total] = await Promise.all([
    db.signal.findMany({
      where,
      orderBy: { lastSeenAt: "desc" },
      skip: input.page * input.limit,
      take: input.limit,
      select: {
        id: true,
        title: true,
        status: true,
        groupKey: true,
        criteriaCovers: true,
        hitCount: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    }),
    db.signal.count({ where }),
  ]);
  return {
    data: signals.map((s) => ({
      signalId: s.id,
      title: s.title,
      status: s.status,
      groupKey: s.groupKey,
      criteriaCovers: s.criteriaCovers,
      hitCount: s.hitCount,
      firstSeenAt: s.firstSeenAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
    })),
    meta: { page: input.page, limit: input.limit, total },
  };
}
