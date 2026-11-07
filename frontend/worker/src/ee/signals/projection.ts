import type { PrismaClient } from "@traceroot/core";
import type { AssignmentRow, SignalsBackend } from "./backend-client.js";
import { ROUND_MAX_HITS } from "./config.js";

type ProjectionDb = Pick<PrismaClient, "signalHit">;

/** A successful old write must never acknowledge a newer user placement. */
export async function writeAssignmentCopies(
  db: ProjectionDb,
  backend: Pick<SignalsBackend, "writeAssignments">,
  batch: AssignmentRow[],
): Promise<void> {
  await backend.writeAssignments(batch);
  for (const copy of batch) {
    if (copy.gave_up) continue;
    await db.signalHit.updateMany({
      where: { runId: copy.run_id, assignedAt: new Date(copy.assigned_at_ms) },
      data: { copyPending: false },
    });
  }
}

/**
 * Repair committed placements even when a copy already exists at an older
 * version, grouping is disabled, or no model key is configured. Embeddings
 * are retained with the assignment; projection failures have no give-up path.
 */
export async function repairAssignmentCopies(
  db: ProjectionDb,
  backend: Pick<SignalsBackend, "writeAssignments">,
  projectId: string,
  detectorId: string,
): Promise<{ runIds: Set<string>; remaining: boolean }> {
  const pending = await db.signalHit.findMany({
    where: { projectId, detectorId, copyPending: true },
    orderBy: { assignedAt: "asc" },
    take: ROUND_MAX_HITS + 1,
    select: {
      runId: true,
      signalId: true,
      projectId: true,
      detectorId: true,
      traceId: true,
      embedding: true,
      score: true,
      criteriaVersion: true,
      assignedAt: true,
    },
  });
  const batch = pending.slice(0, ROUND_MAX_HITS).map((h) => ({
    project_id: h.projectId,
    detector_id: h.detectorId,
    run_id: h.runId,
    trace_id: h.traceId,
    signal_id: h.signalId,
    embedding: h.embedding,
    score: h.score,
    criteria_version: h.criteriaVersion,
    assigned_at_ms: h.assignedAt.getTime(),
  }));
  if (batch.length) await writeAssignmentCopies(db, backend, batch);
  return { runIds: new Set(batch.map((h) => h.run_id)), remaining: pending.length > batch.length };
}
