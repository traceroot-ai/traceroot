import type { PrismaClient } from "@traceroot/core";
import { calculateCost } from "@traceroot/core";
import type { AssignmentRow, SignalsBackend, WaitingHitRow } from "./backend-client.js";
import {
  ASSIGNMENT_FLUSH_ROWS,
  EMBED_CHUNK,
  EMBEDDING_MODEL,
  GIVE_UP_AFTER_FAILURES,
  GIVE_UP_AFTER_MS,
  MAX_CONSECUTIVE_FAILURES,
  ROUND_MAX_HITS,
  ROUND_MAX_MS,
  SHORTLIST_SIZE,
  WAITING_LOOKBACK_MS,
  signalsAvailable,
} from "./config.js";
import { decide } from "./decide.js";
import type { EmbeddingResult } from "./embedding.js";
import { groupSignalText, jevGroupKey } from "./jev-group.js";
import { embeddingText, hitMaterial } from "./material.js";
import { shortlist } from "./shortlist.js";
import { repairAssignmentCopies, writeAssignmentCopies } from "./projection.js";
import {
  UnusableAnswerError,
  type AssignmentModels,
  type Candidate,
  type ModelUsage,
} from "./types.js";
import {
  applyAssignment,
  type AssignmentResult,
  type Placement,
  type WaitingHit,
} from "./write.js";

export type RoundDb = Pick<
  PrismaClient,
  "$transaction" | "detector" | "signal" | "signalHit" | "aIMessage"
>;

/** Per-hit counts of unusable answers, so a hit that keeps getting them is eventually given up. */
export interface HitFailures {
  /** Count one more failure of this hit; returns the count and the first failure time. */
  record(runId: string, now: number): Promise<{ count: number; firstAt: number }>;
  /** Forget the hit's failures, so a replayed hit starts over. */
  clear(runId: string): Promise<void>;
}

export interface RoundDeps {
  db: RoundDb;
  backend: SignalsBackend;
  failures: HitFailures;
  embed(texts: string[]): Promise<EmbeddingResult>;
  /** Model clients for one round; every call's usage is pushed to `usage`. */
  models(usage: ModelUsage[]): Promise<AssignmentModels>;
  now(): number;
}

export interface RoundStats {
  waiting: number;
  created: number;
  attached: number;
  reopened: number;
  /** Already assigned in Postgres; only the ClickHouse copy was written. */
  duplicate: number;
  /** Hits whose processing threw this round; they stay waiting. */
  failed: number;
  /** Hits given up on after repeated unusable answers; they no longer count as waiting. */
  gaveUp: number;
  rejudged: number;
  unvalidated: number;
  /** Age of the oldest waiting hit when the round started: the partition's queue lag. */
  lagMs: number;
  durationMs: number;
  /** Hits may still be waiting; the job should run another round. */
  remaining: boolean;
  /** Why the round assigned nothing without looking. */
  skipped?: "detector-deleted" | "signals-off" | "no-key";
  /** When the round read the waiting hits (or decided to skip): what a drain covers. */
  readAt: number;
}

type PoolEntry = Omit<Candidate, "label"> & { anchorEmbedding: number[] };

function toWaitingHit(row: WaitingHitRow, projectId: string, detectorId: string): WaitingHit {
  const seenAt = new Date(row.timestamp_ms);
  return {
    runId: row.run_id,
    projectId,
    detectorId,
    traceId: row.trace_id,
    findingId: row.finding_id,
    seenAt,
    traceStartTime: row.trace_start_ms === null ? seenAt : new Date(row.trace_start_ms),
    summary: row.summary,
    data: row.data,
    groupKey: jevGroupKey(row.data),
  };
}

/**
 * One round of a partition's assignment job: assign the hits ClickHouse lists
 * as waiting, in time order, at most ROUND_MAX_HITS or ROUND_MAX_MS. Model calls
 * run outside any lock; each hit's Postgres write is its own short locked
 * transaction, so the next hit already sees a signal the previous one created.
 * The ClickHouse copy is written after Postgres; a copy that fails to land
 * leaves the hit waiting, and the next round finds it assigned in Postgres
 * and writes the copy again.
 */
export async function runAssignmentRound(
  deps: RoundDeps,
  projectId: string,
  detectorId: string,
): Promise<RoundStats> {
  const { db } = deps;
  const started = deps.now();
  const stats: RoundStats = {
    waiting: 0,
    created: 0,
    attached: 0,
    reopened: 0,
    duplicate: 0,
    failed: 0,
    gaveUp: 0,
    rejudged: 0,
    unvalidated: 0,
    lagMs: 0,
    durationMs: 0,
    remaining: false,
    readAt: started,
  };

  const repaired = await repairAssignmentCopies(db, deps.backend, projectId, detectorId);
  stats.duplicate = repaired.runIds.size;
  stats.remaining = repaired.remaining;

  const detector = await db.detector.findFirst({
    where: { id: detectorId, projectId },
    select: {
      name: true,
      enableSignals: true,
      signalsEnabledAt: true,
      project: { select: { workspaceId: true } },
    },
  });
  stats.skipped = !detector
    ? "detector-deleted"
    : !detector.enableSignals
      ? "signals-off"
      : !signalsAvailable()
        ? "no-key"
        : undefined;
  if (stats.skipped || !detector) {
    console.log(
      `[Signals] skip project=${projectId} detector=${detectorId} reason=${stats.skipped}`,
    );
    stats.durationMs = deps.now() - started;
    return stats;
  }

  // Hits from before the switch was turned on are never grouped.
  const sinceMs = Math.max(detector.signalsEnabledAt.getTime(), started - WAITING_LOOKBACK_MS);
  stats.readAt = deps.now();
  const waitingRows = await deps.backend.waitingHits(
    projectId,
    detectorId,
    sinceMs,
    ROUND_MAX_HITS,
  );
  // ClickHouse may still return just-repaired copies while they become visible.
  // A full raw page can hide later hits even when filtering removes every row.
  stats.remaining ||= waitingRows.length === ROUND_MAX_HITS;
  const waiting = waitingRows
    .filter((row) => !repaired.runIds.has(row.run_id))
    .map((row) => toWaitingHit(row, projectId, detectorId));
  stats.waiting = waiting.length;
  if (waiting.length === 0) {
    stats.durationMs = deps.now() - started;
    return stats;
  }
  stats.lagMs = Math.max(0, started - waiting[0].seenAt.getTime());

  const usage: ModelUsage[] = [];
  const workspaceId = detector.project.workspaceId;
  const copies: AssignmentRow[] = [];
  let flushError: unknown = null;
  const flush = async () => {
    if (copies.length === 0) return;
    const batch = copies.splice(0);
    try {
      await writeAssignmentCopies(db, deps.backend, batch);
    } catch (err) {
      flushError = err;
      console.error(
        `[Signals] failed to write ${batch.length} assignment copies project=${projectId} detector=${detectorId}:`,
        err,
      );
    }
  };

  let processed = 0;
  let succeeded = 0;
  let lastError: unknown = null;
  // Hits given up this round: their failure counts are cleared once the give-up
  // copy is written, so a copy that fails leaves the count to give them up again.
  const gaveUp: string[] = [];
  try {
    // Hits recorded in Postgres whose ClickHouse copy is missing need no model call.
    const recorded = new Map(
      (
        await db.signalHit.findMany({
          where: { runId: { in: waiting.map((h) => h.runId) } },
          select: { runId: true, embedding: true },
        })
      ).map((r) => [r.runId, r.embedding]),
    );

    const modelHits = waiting.filter((h) => !h.groupKey && !recorded.has(h.runId));
    const vectors = new Map<string, number[]>();
    // Embed in chunks as the round reaches them, so hits left for the next
    // round are not embedded twice.
    const vectorFor = async (hit: WaitingHit): Promise<number[]> => {
      const cached = vectors.get(hit.runId);
      if (cached) return cached;
      const start = modelHits.indexOf(hit);
      const chunk = modelHits.slice(start, start + EMBED_CHUNK);
      const embedded = await deps.embed(chunk.map((h) => embeddingText(h.summary, h.data)));
      usage.push({
        model: EMBEDDING_MODEL,
        provider: "openai",
        isByok: false,
        inputTokens: embedded.inputTokens,
        outputTokens: 0,
        cost: 0,
      });
      chunk.forEach((h, i) => vectors.set(h.runId, embedded.vectors[i]));
      return vectors.get(hit.runId)!;
    };
    let models: AssignmentModels | null = null;

    // Every model-assigned signal in the partition, dismissed and resolved included.
    const pool: PoolEntry[] = (
      await db.signal.findMany({
        where: { projectId, detectorId, mergedIntoId: null, groupKey: null },
        select: {
          id: true,
          title: true,
          criteriaCovers: true,
          criteriaExcludes: true,
          criteriaVersion: true,
          anchorText: true,
          anchorEmbedding: true,
          status: true,
          hitCount: true,
        },
        orderBy: { createTime: "asc" },
      })
    ).map((s) => ({
      signalId: s.id,
      title: s.title,
      covers: s.criteriaCovers,
      excludes: s.criteriaExcludes,
      example: s.anchorText,
      status: s.status,
      hitCount: s.hitCount,
      criteriaVersion: s.criteriaVersion,
      anchorEmbedding: s.anchorEmbedding,
    }));

    const assignOne = async (hit: WaitingHit): Promise<void> => {
      const material = hitMaterial(detector.name, hit.summary, hit.data);
      const vector = recorded.has(hit.runId)
        ? recorded.get(hit.runId)!
        : hit.groupKey
          ? undefined
          : await vectorFor(hit);
      let placement: Placement;
      if (recorded.has(hit.runId)) {
        // The write finds the existing assignment and returns it unchanged.
        placement = { kind: "attach", signalId: "", score: null, criteriaVersion: 0 };
      } else if (hit.groupKey) {
        placement = {
          kind: "group",
          groupKey: hit.groupKey,
          signal: groupSignalText(hit.groupKey),
          anchorText: material,
        };
      } else {
        models ??= await deps.models(usage);
        const candidates = shortlist(vector!, pool, SHORTLIST_SIZE).map((p, i) => ({
          ...p,
          label: `s${i + 1}`,
        }));
        const decision = await decide(material, candidates, models);
        if (decision.rejudged) stats.rejudged++;
        if (decision.kind === "create" && !decision.validated) {
          stats.unvalidated++;
          console.warn(
            `[Signals] new signal criteria failed validation project=${projectId} detector=${detectorId} run=${hit.runId} title=${JSON.stringify(decision.signal.title)}`,
          );
        }
        placement =
          decision.kind === "attach"
            ? {
                kind: "attach",
                signalId: decision.candidate.signalId,
                score: decision.score,
                criteriaVersion: decision.candidate.criteriaVersion,
              }
            : {
                kind: "create",
                signal: decision.signal,
                anchorText: material,
                anchorEmbedding: vector!,
                validated: decision.validated,
              };
      }

      const result: AssignmentResult = await applyAssignment(db, hit, placement, {
        embedding: vector ?? [],
        now: deps.now(),
      });
      stats[result.outcome]++;
      updatePool(pool, result, placement, material, vector);
      copies.push({
        project_id: projectId,
        detector_id: detectorId,
        run_id: hit.runId,
        trace_id: hit.traceId,
        signal_id: result.signalId,
        embedding: vector ?? [],
        score: result.score,
        criteria_version: result.criteriaVersion,
        assigned_at_ms: result.assignedAt.getTime(),
      });
    };

    // A hit that fails is left waiting and the round moves on, so one bad hit
    // cannot hold up the rest of its detector. Failures in a row look like an
    // outage rather than a bad hit, so the round stops there. Only an unusable
    // model answer counts toward giving up on a hit; any other failure is an
    // outage, however long it lasts, and the hit is assigned once it ends.
    let consecutiveFailures = 0;
    for (const hit of waiting) {
      if (processed > 0 && deps.now() - started >= ROUND_MAX_MS) break;
      processed++;
      try {
        await assignOne(hit);
        succeeded++;
        consecutiveFailures = 0;
      } catch (err) {
        stats.failed++;
        consecutiveFailures++;
        lastError = err;
        console.error(
          `[Signals] failed to assign project=${projectId} detector=${detectorId} run=${hit.runId}:`,
          err,
        );
        // A committed assignment only needs its projection repaired. It must
        // never acquire an empty-signal give-up row because a provider is down.
        if (recorded.has(hit.runId)) {
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
          continue;
        }
        if (!(err instanceof UnusableAnswerError)) {
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
          continue;
        }
        const failure = await deps.failures.record(hit.runId, deps.now());
        if (
          failure.count >= GIVE_UP_AFTER_FAILURES &&
          deps.now() - failure.firstAt >= GIVE_UP_AFTER_MS
        ) {
          // Marked in ClickHouse so it stops counting as waiting; nothing is
          // written to Postgres, so it belongs to no signal. Its count is
          // cleared after the copy lands, so a replayed hit starts over.
          stats.gaveUp++;
          console.error(
            `[Signals] giving up on run=${hit.runId} after ${failure.count} unusable answers since ${new Date(failure.firstAt).toISOString()}; last: ${err.message}`,
          );
          gaveUp.push(hit.runId);
          copies.push({
            project_id: projectId,
            detector_id: detectorId,
            run_id: hit.runId,
            trace_id: hit.traceId,
            signal_id: "",
            embedding: [],
            score: null,
            criteria_version: null,
            assigned_at_ms: deps.now(),
            gave_up: true,
          });
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      }
      if (copies.length >= ASSIGNMENT_FLUSH_ROWS) await flush();
    }
  } finally {
    // Whatever was recorded in Postgres gets its copy, and billed calls stay
    // findable, even when the round fails part-way.
    await flush();
    await recordUsage(db, workspaceId, usage);
    // After the usage is recorded, and best-effort: a kept count only gives
    // the hit up again sooner.
    if (!flushError) {
      for (const runId of gaveUp) {
        await deps.failures
          .clear(runId)
          .catch((err) =>
            console.error(`[Signals] failed to clear failures of run=${runId}:`, err),
          );
      }
    }
  }
  // Postgres is correct either way; failing the job retries with backoff
  // instead of re-reading the same hits in a tight loop.
  if (flushError) throw flushError;
  // Nothing moved forward: back off rather than retry the same hits at once.
  if (stats.failed > 0 && succeeded === 0 && stats.gaveUp === 0) throw lastError;

  stats.remaining ||= waiting.length === ROUND_MAX_HITS || processed < waiting.length;
  stats.durationMs = deps.now() - started;
  console.log(
    `[Signals] round project=${projectId} detector=${detectorId} waiting=${stats.waiting} ` +
      `created=${stats.created} attached=${stats.attached} reopened=${stats.reopened} ` +
      `duplicate=${stats.duplicate} failed=${stats.failed} gave_up=${stats.gaveUp} ` +
      `rejudged=${stats.rejudged} unvalidated=${stats.unvalidated} ` +
      `lag_ms=${stats.lagMs} duration_ms=${stats.durationMs} remaining=${stats.remaining}`,
  );
  return stats;
}

/** Keep the in-memory candidates current, so the next hit sees this one's effect. */
function updatePool(
  pool: PoolEntry[],
  result: AssignmentResult,
  placement: Placement,
  material: string,
  vector: number[] | undefined,
): void {
  if (result.outcome === "created" && placement.kind === "create" && vector) {
    pool.push({
      signalId: result.signalId,
      title: placement.signal.title,
      covers: placement.signal.covers,
      excludes: placement.signal.excludes,
      example: material,
      status: "open",
      hitCount: 1,
      criteriaVersion: 1,
      anchorEmbedding: vector,
    });
    return;
  }
  const entry = pool.find((p) => p.signalId === result.signalId);
  if (!entry || result.outcome === "duplicate") return;
  entry.hitCount++;
  if (result.outcome === "reopened") entry.status = "open";
}

/**
 * One ai_messages row per model per round. Kind "signal-assignment" is not one
 * of the kinds billing aggregates, so these calls are recorded, not charged.
 */
async function recordUsage(db: RoundDb, workspaceId: string, usage: ModelUsage[]): Promise<void> {
  const byModel = new Map<string, ModelUsage>();
  for (const u of usage) {
    const key = `${u.model}|${u.provider}|${u.isByok}`;
    const sum = byModel.get(key);
    if (sum) {
      sum.inputTokens += u.inputTokens;
      sum.outputTokens += u.outputTokens;
      sum.cost += u.cost;
    } else {
      byModel.set(key, { ...u });
    }
  }
  if (byModel.size === 0) return;
  try {
    const rows = await Promise.all(
      [...byModel.values()].map(async (u) => ({
        workspaceId,
        sessionId: null,
        kind: "signal-assignment",
        turnKind: "detector" as const,
        role: "assistant",
        content: "",
        model: u.model,
        provider: u.provider,
        isByok: u.isByok,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cost:
          u.cost > 0
            ? u.cost
            : await calculateCost(u.model, u.inputTokens, u.outputTokens).catch(() => 0),
      })),
    );
    await db.aIMessage.createMany({ data: rows });
  } catch (err) {
    console.error(`[Signals] failed to record model usage for workspace ${workspaceId}:`, err);
  }
}
