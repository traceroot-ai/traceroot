/**
 * Loop writes, each inside a transaction the caller owns: a Loop with its
 * hidden detector, its deletion, runs with a per-Loop sequence, memory notes,
 * and the row locks that keep concurrent writes from passing a cap or taking
 * one run number twice.
 */
import type { LoopRun, Prisma } from "@prisma/client";
import {
  ACTIVE_RUN_STATUSES,
  LOOP_LIMITS,
  LOOP_MEMORY,
  type LoopRunStatus,
  type LoopRunTrigger,
} from "./contracts.ts";
import { deletedLoopDetectorName, LOOP_DETECTOR_TEMPLATE, loopDetectorName } from "./keys.ts";
import { nextRunAt, scheduleToColumns, type LoopSchedule } from "./schedule.ts";

type Tx = Prisma.TransactionClient;

export interface NewLoop {
  projectId: string;
  createdBy: string;
  name: string;
  template: string | null;
  instructions: string;
  schedule: LoopSchedule;
  dryRun: boolean;
  lookbackHours: number;
  model: string | null;
  provider: string | null;
  source: "system" | "byok" | null;
  /** The first run is scheduled after this instant. */
  now: Date;
}

/** Create a Loop and its hidden detector. */
export async function createLoopWithDetector(tx: Tx, input: NewLoop) {
  const detector = await tx.detector.create({
    data: {
      projectId: input.projectId,
      name: loopDetectorName(input.name),
      template: LOOP_DETECTOR_TEMPLATE,
      prompt: "",
      outputSchema: [],
      sampleRate: 0,
      enabled: false,
      // A Loop finding is a pattern over many traces; RCA explains one trace.
      enableRca: false,
      enableSignals: true,
    },
    select: { id: true },
  });
  return tx.loop.create({
    data: {
      projectId: input.projectId,
      detectorId: detector.id,
      name: input.name,
      template: input.template,
      instructions: input.instructions,
      ...scheduleToColumns(input.schedule),
      dryRun: input.dryRun,
      lookbackHours: input.lookbackHours,
      model: input.model,
      provider: input.provider,
      source: input.source,
      nextRunAt: nextRunAt(input.schedule, input.now),
      createdBy: input.createdBy,
    },
  });
}

/**
 * Whether the project already has its most Loops. Locks the project row first,
 * so concurrent creates in one project count one after another.
 */
export async function projectAtLoopCap(tx: Tx, projectId: string): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR NO KEY UPDATE`;
  return (await tx.loop.count({ where: { projectId } })) >= LOOP_LIMITS.loopsPerProject;
}

/**
 * Delete the Loop and keep its hidden detector, so the Loop's signals still
 * trace back to a Loop. The detector gives up "loop:<name>" for a name of its
 * own, so a new Loop can take the deleted one's name.
 */
export async function deleteLoopKeepingDetector(
  tx: Tx,
  loop: { id: string; detectorId: string },
): Promise<void> {
  await tx.loop.delete({ where: { id: loop.id } });
  await tx.detector.update({
    where: { id: loop.detectorId },
    data: { name: deletedLoopDetectorName(loop.detectorId) },
  });
}

/** Keep the detector's name in step with a renamed Loop. */
export async function renameLoopDetector(
  tx: Tx,
  loop: { detectorId: string },
  newName: string,
): Promise<void> {
  await tx.detector.update({
    where: { id: loop.detectorId },
    data: { name: loopDetectorName(newName) },
  });
}

/**
 * The Loop, read under a row lock: a pause, delete or second "Run now"
 * committed meanwhile is seen here. Null when the project has no such Loop.
 */
export async function lockLoop(
  tx: Tx,
  projectId: string,
  loopId: string,
): Promise<{ id: string; name: string; status: string } | null> {
  const [loop] = await tx.$queryRaw<{ id: string; name: string; status: string }[]>`
    SELECT id, name, status FROM loops
    WHERE id = ${loopId} AND project_id = ${projectId}
    FOR NO KEY UPDATE`;
  return loop ?? null;
}

/** Whether the Loop has a run still going; read under lockLoop, a Loop never has two. */
export async function hasActiveRun(tx: Tx, loopId: string): Promise<boolean> {
  const active = await tx.loopRun.findFirst({
    where: { loopId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  return active !== null;
}

/**
 * Insert a run with the next sequence number of its Loop. The Loop row is
 * locked for the insert, so two concurrent creates take different numbers
 * (the unique index on loop and seq is the backstop, not the mechanism).
 */
export async function createRun(
  tx: Tx,
  input: {
    loopId: string;
    projectId: string;
    trigger: LoopRunTrigger;
    slotAt?: Date | null;
    status?: LoopRunStatus;
    data?: Partial<Omit<Prisma.LoopRunUncheckedCreateInput, "loopId" | "projectId" | "seq">>;
  },
): Promise<LoopRun> {
  await tx.$queryRaw`SELECT id FROM loops WHERE id = ${input.loopId} FOR NO KEY UPDATE`;
  const last = await tx.loopRun.aggregate({
    where: { loopId: input.loopId },
    _max: { seq: true },
  });
  return tx.loopRun.create({
    data: {
      ...input.data,
      loopId: input.loopId,
      projectId: input.projectId,
      seq: (last._max.seq ?? 0) + 1,
      trigger: input.trigger,
      slotAt: input.slotAt ?? null,
      status: input.status ?? "pending",
    },
  });
}

export type MemoryWrite = { ok: true; id: string } | { ok: false; error: string };

/**
 * Write a memory note. Notes are shared by the project's Loops: writing a key
 * updates that note, and `loopId` records the writer.
 */
export async function upsertMemory(
  db: Tx,
  input: {
    projectId: string;
    loopId: string | null;
    key: string;
    content: string;
    expiresAt?: Date | null;
    runId?: string | null;
  },
): Promise<MemoryWrite> {
  const key = input.key.trim();
  if (key.length === 0 || key.length > LOOP_MEMORY.keyMaxLength) {
    return { ok: false, error: `key must be 1 to ${LOOP_MEMORY.keyMaxLength} characters` };
  }
  if (new TextEncoder().encode(input.content).length > LOOP_MEMORY.contentMaxBytes) {
    return { ok: false, error: `content must be at most ${LOOP_MEMORY.contentMaxBytes} bytes` };
  }
  const data = {
    loopId: input.loopId,
    content: input.content,
    expiresAt: input.expiresAt ?? null,
    updatedByRunId: input.runId ?? null,
  };
  const row = await db.loopMemory.upsert({
    where: { projectId_key: { projectId: input.projectId, key } },
    create: { projectId: input.projectId, key, ...data },
    update: data,
    select: { id: true },
  });
  return { ok: true, id: row.id };
}
