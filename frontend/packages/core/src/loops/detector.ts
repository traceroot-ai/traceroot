/**
 * The hidden detector each Loop owns. Every finding a Loop records becomes a
 * hit of this detector, so every signal it creates carries `detectorId` and
 * the signal's provenance needs no column of its own. The row never runs on
 * ingest (`enabled` false) and detector lists skip template "loop".
 */
import type { Prisma } from "@prisma/client";
import type { LoopSchedule } from "./schedule.ts";
import { nextRunAt, scheduleToColumns } from "./schedule.ts";
import type { LoopStatus } from "./contracts.ts";

export const LOOP_DETECTOR_TEMPLATE = "loop";

/** The detector's name: unique per project because the Loop's name is. */
export function loopDetectorName(loopName: string): string {
  return `loop:${loopName}`;
}

export interface NewLoop {
  projectId: string;
  createdBy: string;
  name: string;
  template: string | null;
  templateVersion: number | null;
  instructions: string;
  schedule: LoopSchedule;
  dryRun: boolean;
  precheckSql: string | null;
  lookbackHours: number;
  maxFindingsPerRun: number;
  model: string | null;
  provider: string | null;
  source: "system" | "byok" | null;
  /** The first run is scheduled after this instant. */
  now: Date;
}

/** Create a Loop and its hidden detector in one call; the caller owns the transaction. */
export async function createLoopWithDetector(tx: Prisma.TransactionClient, input: NewLoop) {
  const detector = await tx.detector.create({
    data: {
      projectId: input.projectId,
      name: loopDetectorName(input.name),
      template: LOOP_DETECTOR_TEMPLATE,
      prompt: "",
      outputSchema: [],
      sampleRate: 0,
      enabled: false,
      enableRca: true,
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
      templateVersion: input.templateVersion,
      instructions: input.instructions,
      ...scheduleToColumns(input.schedule),
      dryRun: input.dryRun,
      precheckSql: input.precheckSql,
      lookbackHours: input.lookbackHours,
      maxFindingsPerRun: input.maxFindingsPerRun,
      model: input.model,
      provider: input.provider,
      source: input.source,
      nextRunAt: nextRunAt(input.schedule, input.now),
      createdBy: input.createdBy,
    },
  });
}

/** Delete the Loop, then its detector (the foreign key restricts the other order). */
export async function deleteLoopWithDetector(
  tx: Prisma.TransactionClient,
  loop: { id: string; detectorId: string },
): Promise<void> {
  await tx.loop.delete({ where: { id: loop.id } });
  await tx.detector.delete({ where: { id: loop.detectorId } });
}

/** Keep the detector's name in step with a renamed Loop. */
export async function renameLoopDetector(
  tx: Prisma.TransactionClient,
  loop: { detectorId: string },
  newName: string,
): Promise<void> {
  await tx.detector.update({
    where: { id: loop.detectorId },
    data: { name: loopDetectorName(newName) },
  });
}

/** What a status change writes; `by` is null when the system made it. */
export function statusChange(
  status: LoopStatus,
  by: string | null,
  now: Date,
  pauseReason: "failures" | null = null,
) {
  return {
    status,
    pauseReason: status === "paused_by_system" ? pauseReason : null,
    statusChangedAt: now,
    statusChangedBy: by,
  };
}
