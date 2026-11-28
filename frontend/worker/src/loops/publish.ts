/**
 * Publishing a run's findings once its finish accepted them. The finish that
 * marks the run succeeded also stores its findings on the row
 * (metadata.pendingFindings), and lands only while the run is still the try's
 * (see finishLoopRun), so a stale try never has findings to publish. Publishing
 * reads them back from the row, writes them as hits of the Loop's hidden
 * detector, and then clears them. Every hit has a deterministic id and the
 * accepted timestamp, so publishing again after a crash, a failed write or a
 * slow backend rewrites the same rows.
 *
 * Each publish try holds a claim: `tries` counts the tries claimed so far, and
 * a try only clears the payload while the count is still its own, so a later
 * try is never undone by an earlier one that finished late. The Loop tick
 * claims and republishes payloads whose last claim is older than a grace
 * period, and gives up after LOOP_PUBLISH_MAX_TRIES: the run stays succeeded
 * and its error says that some findings were not recorded.
 */
import { prisma, Prisma } from "@traceroot/core";
import { loopFindingSchema, type LoopFinding } from "@traceroot/core/loops";
import { mapWithConcurrency } from "../alerts/concurrency.js";
import { recordLoopFindings } from "./findings.js";

/** The metadata entry that holds a run's unpublished findings. */
export const PENDING_FINDINGS_KEY = "pendingFindings";

export interface PendingFindings {
  /** The accepted findings, each key once. */
  findings: LoopFinding[];
  /** Every hit's timestamp: when the run accepted them. */
  atMs: number;
  /** Publish tries claimed so far; the current try's own number. */
  tries: number;
  /** When the current try claimed the payload. */
  claimedAtMs: number;
}

/** Publish tries before the run gives up on the findings it could not record. */
export const LOOP_PUBLISH_MAX_TRIES = 5;
/** A claim older than this is taken over by the tick. */
export const LOOP_PUBLISH_GRACE_MS = 2 * 60_000;
/** Runs one tick republishes at most, all at once. */
export const LOOP_PUBLISH_BATCH = 5;

export const LOOP_FINDINGS_FAILED = "Some of the run's findings could not be recorded.";

const findingsSchema = loopFindingSchema.array();

/** The payload a finish stores, claimed by the worker that accepts it. */
export function pendingFindingsOf(
  findings: readonly LoopFinding[],
  nowMs: number,
): PendingFindings {
  const seen = new Set<string>();
  return {
    findings: findings.filter((f) => !seen.has(f.key) && seen.add(f.key)),
    atMs: nowMs,
    tries: 1,
    claimedAtMs: nowMs,
  };
}

function readPending(metadata: Prisma.JsonValue | null | undefined): PendingFindings | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata[PENDING_FINDINGS_KEY] as Record<string, unknown> | null | undefined;
  if (!value || typeof value !== "object") return null;
  const findings = findingsSchema.safeParse(value.findings);
  const { atMs, tries, claimedAtMs } = value;
  if (
    !findings.success ||
    typeof atMs !== "number" ||
    typeof tries !== "number" ||
    typeof claimedAtMs !== "number"
  ) {
    return null;
  }
  return { findings: findings.data, atMs, tries, claimedAtMs };
}

/** Clear the payload while try `tries` still holds it, optionally recording an error. */
async function clearPending(runId: string, tries: number, error?: string): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE loop_runs
    SET metadata = metadata - 'pendingFindings'
      ${error === undefined ? Prisma.empty : Prisma.sql`, error = ${error}`}
    WHERE id = ${runId}
      AND (metadata->'pendingFindings'->>'tries')::int = ${tries}::int`;
  return count > 0;
}

/** Take the payload over from try `tries` as the next try. */
async function claimPending(runId: string, tries: number, nowMs: number): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE loop_runs
    SET metadata = jsonb_set(
      jsonb_set(metadata, '{pendingFindings,tries}', to_jsonb(${tries + 1}::int)),
      '{pendingFindings,claimedAtMs}', to_jsonb(${nowMs}::bigint))
    WHERE id = ${runId}
      AND (metadata->'pendingFindings'->>'tries')::int = ${tries}::int`;
  return count > 0;
}

export type PublishOutcome = "published" | "retry" | "gave_up" | "not_pending";

/**
 * Publish the run's stored findings as try `tries`: every hit is written, and
 * the payload is cleared only when none failed. A failed try leaves it for the
 * tick, unless it was the last try, which gives up. "not_pending" when the run
 * holds no payload for this try (already published, or claimed by a later try).
 */
export async function publishLoopFindings(runId: string, tries: number): Promise<PublishOutcome> {
  const run = await prisma.loopRun.findUnique({
    where: { id: runId },
    select: { projectId: true, metadata: true, loop: { select: { name: true, detectorId: true } } },
  });
  const pending = readPending(run?.metadata);
  if (!run || !pending || pending.tries !== tries) return "not_pending";

  let complete = false;
  try {
    const { failed } = await recordLoopFindings({
      projectId: run.projectId,
      loop: run.loop,
      findings: pending.findings,
      now: () => pending.atMs,
    });
    complete = failed === 0;
  } catch (error) {
    console.error(`[Loops] run=${runId} publish try ${tries} wrote no finding:`, error);
  }
  if (complete) {
    await clearPending(runId, tries);
    return "published";
  }
  if (tries >= LOOP_PUBLISH_MAX_TRIES) {
    await clearPending(runId, tries, LOOP_FINDINGS_FAILED);
    console.error(`[Loops] run=${runId} gave up publishing its findings after ${tries} tries`);
    return "gave_up";
  }
  console.error(`[Loops] run=${runId} publish try ${tries} incomplete; the tick retries it`);
  return "retry";
}

/**
 * The tick's step for one run whose payload try `tries` claimed: give up when
 * every try was used, else claim it as the next try and publish. Null when
 * another publisher moved the payload first.
 */
export async function recoverPendingFindings(
  run: { id: string; tries: number },
  now: Date,
): Promise<PublishOutcome | null> {
  if (run.tries >= LOOP_PUBLISH_MAX_TRIES) {
    if (!(await clearPending(run.id, run.tries, LOOP_FINDINGS_FAILED))) return null;
    console.error(`[Loops] run=${run.id} gave up publishing its findings after ${run.tries} tries`);
    return "gave_up";
  }
  if (!(await claimPending(run.id, run.tries, now.getTime()))) return null;
  return publishLoopFindings(run.id, run.tries + 1);
}

/**
 * Republish the findings of runs whose last publish try claimed them more than
 * `graceMs` ago and never cleared them: the worker crashed, a write failed, or
 * the backend was slow. At most `batch` runs, oldest claim first.
 */
export async function republishPendingFindings(
  now: Date,
  { graceMs = LOOP_PUBLISH_GRACE_MS, batch = LOOP_PUBLISH_BATCH } = {},
): Promise<Record<PublishOutcome, number>> {
  const cutoff = now.getTime() - graceMs;
  const due = await prisma.$queryRaw<{ id: string; tries: number }[]>`
    SELECT id, (metadata->'pendingFindings'->>'tries')::int AS tries
    FROM loop_runs
    WHERE status = 'succeeded'
      AND metadata->'pendingFindings' IS NOT NULL
      AND (metadata->'pendingFindings'->>'claimedAtMs')::bigint < ${cutoff}::bigint
    ORDER BY (metadata->'pendingFindings'->>'claimedAtMs')::bigint, id
    LIMIT ${batch}`;
  const counts: Record<PublishOutcome, number> = {
    published: 0,
    retry: 0,
    gave_up: 0,
    not_pending: 0,
  };
  const outcomes = await mapWithConcurrency(due, batch, (run) =>
    recoverPendingFindings(run, now).catch((error: unknown) => {
      console.error(`[Loops] run=${run.id} republish failed:`, error);
      return null;
    }),
  );
  for (const outcome of outcomes) if (outcome) counts[outcome] += 1;
  return counts;
}
