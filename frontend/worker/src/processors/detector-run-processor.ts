import { Worker, Queue, DelayedError, type Job } from "bullmq";
import { createHash } from "crypto";
import type { Redis } from "ioredis";
import { prisma, PlanType } from "@traceroot/core";
import type {
  DetectorRunJob,
  DetectorRcaJob,
  DetectorRcaFinding,
} from "../queues/detector-run-queue.js";
import {
  DETECTOR_RUN_QUEUE,
  DETECTOR_RCA_QUEUE,
  createRedisConnection,
} from "../queues/detector-run-queue.js";
import { runDetectionForTrace } from "../detection/sandbox-eval.js";
import { writeDetectorRun, writeDetectorFinding } from "../detection/clickhouse-writer.js";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

/** A trace counts as quiescent once no span has arrived for this long. */
export const QUIESCENCE_SECONDS = 20;
/** Re-check delays while waiting for a trace to settle; stays at the last entry. */
export const BOUNCE_DELAYS_MS = [30_000, 60_000, 120_000];
/** Hard cap on total wait (measured from job.timestamp) before evaluating anyway. */
export const MAX_WAIT_MS = 10 * 60_000;
/** Consecutive quiet checks with an unchanged dangling set before giving up waiting. */
export const NO_PROGRESS_LIMIT = 3;

export type PartialReason = "cap_expired" | "no_progress" | null;

export interface SettleStatus {
  root_present: boolean;
  span_count: number;
  dangling_count: number;
  dangling_hash: string;
  last_arrival_age_seconds: number;
}

export type SettleDecision =
  | { action: "evaluate"; partialReason: PartialReason }
  | { action: "bounce"; partialReason: null; nextData: DetectorRunJob; delayMs: number };

/**
 * Pure settle-gate decision: evaluate now (and with what disclosure), or
 * bounce the job back to the delayed set and re-check later.
 */
export function decideSettleAction(
  settle: SettleStatus,
  jobData: DetectorRunJob,
  elapsedMs: number,
): SettleDecision {
  const quiet = settle.last_arrival_age_seconds >= QUIESCENCE_SECONDS;
  const settled = settle.root_present && settle.dangling_count === 0 && quiet;
  if (settled) return { action: "evaluate", partialReason: null };

  if (elapsedMs >= MAX_WAIT_MS) return { action: "evaluate", partialReason: "cap_expired" };

  // No-progress early-out: dropped spans or partially-instrumented systems
  // leave parents that will never arrive; waiting out the full cap on every
  // such trace would make the worst case the normal path.
  const sameDanglingSet =
    settle.dangling_count > 0 && quiet && settle.dangling_hash === jobData.lastDanglingHash;
  const sameHashCount = sameDanglingSet ? (jobData.sameHashCount ?? 0) + 1 : 0;
  if (sameHashCount >= NO_PROGRESS_LIMIT) {
    return { action: "evaluate", partialReason: "no_progress" };
  }

  const bounces = jobData.bounces ?? 0;
  return {
    action: "bounce",
    partialReason: null,
    nextData: {
      ...jobData,
      bounces: bounces + 1,
      lastDanglingHash: settle.dangling_hash,
      sameHashCount,
    },
    delayMs: BOUNCE_DELAYS_MS[Math.min(bounces, BOUNCE_DELAYS_MS.length - 1)],
  };
}

async function fetchSettleStatus(projectId: string, traceId: string): Promise<SettleStatus> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/internal/traces/${traceId}/settle-status?project_id=${projectId}`,
    { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch settle status for trace ${traceId}: HTTP ${response.status}`);
  }
  return (await response.json()) as SettleStatus;
}

/**
 * Deterministic run id keyed on (projectId, traceId, detectorId).
 * On a BullMQ retry, the same triple lands on the same runId — so re-writes
 * collapse with detector_findings.findingId rather than producing duplicate
 * run rows for the same (detector, trace).
 */
/** Hash a string to a uuid-shaped id (first 128 bits of sha256, 8-4-4-4-12). */
function hashToUuid(input: string): string {
  return createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

function deterministicRunId(projectId: string, traceId: string, detectorId: string): string {
  return hashToUuid(`${projectId}:${traceId}:${detectorId}`);
}

/**
 * Decide whether to run the per-trace RCA. RCA is shared across all detectors
 * that fired on a trace; we run it when AT LEAST ONE triggered detector has
 * RCA enabled. A triggered detector missing from `detectors` defaults to "run"
 * so an unexpected gap never silently suppresses analysis.
 */
export function shouldRunRca(
  triggered: { detectorId: string }[],
  detectors: { id: string; enableRca: boolean }[],
): boolean {
  const rcaEnabledById = new Map(detectors.map((d) => [d.id, d.enableRca]));
  return triggered.some((t) => rcaEnabledById.get(t.detectorId) !== false);
}

/**
 * Deterministic finding id for a trace — a hash of (projectId, traceId) only.
 * It does NOT depend on which/how many detectors fired, so every detector that
 * triggers on the same trace maps to the SAME finding, and therefore the SAME
 * RCA job (`rca-${findingId}`): exactly one RCA per trace, and a BullMQ retry
 * lands on the same row instead of duplicating it.
 */
export function traceFindingId(projectId: string, traceId: string): string {
  return hashToUuid(`${projectId}:${traceId}`);
}

/**
 * Build the per-trace RCA payload from every detector that fired. The single
 * RCA job carries all triggered detectors' summaries, so one agent analyzes the
 * whole trace rather than one agent per detector.
 */
export function buildRcaFindings(
  triggered: { detectorId: string; detectorName: string; summary: string }[],
): DetectorRcaFinding[] {
  return triggered.map((r) => ({
    detectorId: r.detectorId,
    detectorName: r.detectorName,
    summary: r.summary,
  }));
}

let rcaQueue: Queue<DetectorRcaJob> | null = null;
function getRcaQueue(): Queue<DetectorRcaJob> {
  if (!rcaQueue) {
    rcaQueue = new Queue<DetectorRcaJob>(DETECTOR_RCA_QUEUE, {
      connection: createRedisConnection(),
    });
  }
  return rcaQueue;
}

// Dedicated connection for the post-eval state key (not a BullMQ connection,
// which is reserved for queue traffic).
let lockRedis: Redis | null = null;
function getLockRedis(): Redis {
  if (!lockRedis) lockRedis = createRedisConnection();
  return lockRedis;
}

async function downloadSpansJsonl(projectId: string, traceId: string): Promise<string> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/internal/traces/${traceId}/spans-jsonl?project_id=${projectId}`,
    { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
  );
  if (!response.ok) {
    throw new Error(`Failed to download spans for trace ${traceId}: HTTP ${response.status}`);
  }
  return response.text();
}

interface TriggeredResult {
  detectorId: string;
  detectorName: string;
  summary: string;
  data: unknown;
}

export interface ScanUsage {
  inferenceCost: number;
  inferenceInputTokens: number;
  inferenceOutputTokens: number;
  inferenceSource: "system" | "byok" | null;
  inferenceModel: string | null;
  inferenceProvider: string | null;
}

interface SingleDetectorOutcome {
  triggered: TriggeredResult | null;
  /** null when the eval threw before pi-ai was called (cost/source unknown). */
  usage: ScanUsage | null;
}

/**
 * Run one detector against a trace. Writes the run record immediately for
 * non-triggered and failed cases (finding_id = null). For triggered cases,
 * returns the result WITHOUT writing anything — processTrace handles the
 * finding write and the run write so all triggered runs share the same
 * finding_id.
 */
async function runSingleDetector(params: {
  detector: {
    id: string;
    name: string;
    prompt: string;
    outputSchema: Array<{ name: string; type: string }>;
    detectionModel: string | null;
    detectionProvider: string | null;
    detectionSource: "system" | "byok" | null;
  };
  traceId: string;
  projectId: string;
  spansJsonl: string;
  workspaceId: string;
  partialReason: PartialReason;
}): Promise<SingleDetectorOutcome> {
  const { detector, traceId, projectId, spansJsonl, workspaceId, partialReason } = params;
  const runId = deterministicRunId(projectId, traceId, detector.id);

  let result: Awaited<ReturnType<typeof runDetectionForTrace>>;
  try {
    result = await runDetectionForTrace({
      traceId,
      spansJsonl,
      detector: {
        id: detector.id,
        name: detector.name,
        prompt: detector.prompt,
        outputSchema: detector.outputSchema,
        detectionModel: detector.detectionModel,
        detectionProvider: detector.detectionProvider,
        detectionSource: detector.detectionSource,
      },
      workspaceId,
      partialReason,
    });
  } catch (e) {
    console.error(`[Detector] Run failed for detector ${detector.id} on trace ${traceId}:`, e);
    await writeDetectorRun({
      runId,
      detectorId: detector.id,
      projectId,
      traceId,
      findingId: null,
      status: "failed",
    }).catch((err) => console.error("[Detector] Failed to write run:", err));
    return { triggered: null, usage: null };
  }

  const usage: ScanUsage = {
    inferenceCost: result.inferenceCost,
    inferenceInputTokens: result.inferenceInputTokens,
    inferenceOutputTokens: result.inferenceOutputTokens,
    inferenceSource: result.inferenceSource,
    inferenceModel: result.inferenceModel,
    inferenceProvider: result.inferenceProvider,
  };

  if (!result.identified) {
    if (result.error) {
      console.error(
        `[Detector] Eval failed for detector ${detector.name} (${detector.id}) on trace ${traceId}: ${result.error}`,
      );
    }
    // Not triggered — write run immediately (no finding_id)
    await writeDetectorRun({
      runId,
      detectorId: detector.id,
      projectId,
      traceId,
      findingId: null,
      status: result.error ? "failed" : "completed",
    }).catch((err) => console.error("[Detector] Failed to write run:", err));
    return { triggered: null, usage };
  }

  // Triggered — return result without writing anything.
  // flushTrace will generate the shared finding_id, write the finding, then write this run.
  console.log(
    `[Detector] Detector ${detector.name} triggered on trace ${traceId}: ${result.summary.slice(0, 80)}`,
  );
  return {
    triggered: {
      detectorId: detector.id,
      detectorName: detector.name,
      summary: result.summary,
      data: result.data,
    },
    usage,
  };
}

export interface ProcessTraceOptions {
  partialReason: PartialReason;
  isReeval: boolean;
}

export async function processTrace(
  traceId: string,
  projectId: string,
  detectorIds: string[],
  options: ProcessTraceOptions,
): Promise<void> {
  console.log(`[Detector] Processing trace ${traceId} with ${detectorIds.length} detector(s)`);

  let spansJsonl: string;
  try {
    spansJsonl = await downloadSpansJsonl(projectId, traceId);
  } catch (e) {
    console.error(`[Detector] Failed to download spans for trace ${traceId}:`, e);
    await Promise.allSettled(
      detectorIds.map((detectorId) =>
        writeDetectorRun({
          runId: deterministicRunId(projectId, traceId, detectorId),
          detectorId,
          projectId,
          traceId,
          findingId: null,
          status: "failed",
        }).catch((err) => console.error("[Detector] Failed to write run:", err)),
      ),
    );
    return;
  }

  await evaluateTrace(traceId, projectId, detectorIds, spansJsonl, options);

  // Post-eval state for the Python enqueue side, which reads this key to
  // decide the single allowed re-evaluation when later spans arrive.
  const spanCount = spansJsonl.split("\n").filter((line) => line.trim() !== "").length;
  try {
    await getLockRedis().set(
      `detector-enq:${projectId}:${traceId}`,
      JSON.stringify({
        state: "evaluated",
        detector_ids: detectorIds,
        span_count: spanCount,
        reevals: options.isReeval ? 1 : 0,
      }),
      "EX",
      3600,
    );
  } catch (err) {
    console.error(`[Detector] Failed to write evaluated state for trace ${traceId}:`, err);
  }
}

/**
 * On a clean re-evaluation, withdraw the finding the first evaluation wrote
 * (if any) with a newer-timestamp tombstone row: ReplacingMergeTree plus the
 * read-side retracted filter make the stale finding disappear.
 */
async function retractStaleFinding(projectId: string, traceId: string): Promise<void> {
  const findingId = traceFindingId(projectId, traceId);
  let exists: boolean;
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/internal/traces/${traceId}/findings?project_id=${projectId}`,
      { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as { findings?: Array<{ finding_id: string }> };
    exists = (body.findings ?? []).some((f) => f.finding_id === findingId);
  } catch (err) {
    console.error(`[Detector] Failed to check existing findings for trace ${traceId}:`, err);
    return;
  }
  if (!exists) return;

  try {
    await writeDetectorFinding({
      findingId,
      projectId,
      traceId,
      summary: "",
      payload: "",
      retracted: true,
    });
    console.log(`[Detector] retracted finding=${findingId} trace=${traceId}`);
  } catch (err) {
    console.error(`[Detector] Failed to write retraction for finding ${findingId}:`, err);
  }
}

async function evaluateTrace(
  traceId: string,
  projectId: string,
  detectorIds: string[],
  spansJsonl: string,
  options: ProcessTraceOptions,
): Promise<void> {
  const [detectors, project] = await Promise.all([
    prisma.detector.findMany({
      where: { id: { in: detectorIds }, enabled: true },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        workspaceId: true,
        workspace: { select: { billingPlan: true, detectorBlocked: true } },
      },
    }),
  ]);

  const projectName = project?.name ?? "";
  const workspaceId = project?.workspaceId ?? "";

  // Free-plan detector cap enforcement — read the cached `detectorBlocked`
  // flag set by the hourly billing job (same pattern as `aiBlocked` and
  // `ingestionBlocked`). Worst-case overshoot: ~1h of scans between cron
  // runs, which costs us a few cents of haiku tokens — acceptable as
  // customer-acquisition spend per the pricing rule "Free is truly free."
  const billingPlan = (project?.workspace?.billingPlan ?? "free") as PlanType;
  if (project?.workspace?.detectorBlocked && billingPlan === PlanType.FREE) {
    console.log(
      `[Detector] Workspace ${workspaceId} is detector-blocked (Free plan cap exceeded); ` +
        `skipping ${detectors.length} scan(s) for trace ${traceId}`,
    );
    return;
  }

  // Run all detectors in parallel; collect triggered results
  const settled = await Promise.allSettled(
    detectors.map((detector) => {
      const outputSchema = Array.isArray(detector.outputSchema)
        ? (detector.outputSchema as Array<{ name: string; type: string }>)
        : [];

      return runSingleDetector({
        detector: {
          id: detector.id,
          name: detector.name,
          prompt: detector.prompt,
          outputSchema,
          detectionModel: detector.detectionModel,
          detectionProvider: detector.detectionProvider,
          detectionSource: detector.detectionSource as "system" | "byok" | null,
        },
        traceId,
        projectId,
        spansJsonl,
        workspaceId,
        partialReason: options.partialReason,
      });
    }),
  );

  const fulfilled = settled
    .filter((r): r is PromiseFulfilledResult<SingleDetectorOutcome> => r.status === "fulfilled")
    .map((r) => r.value);

  // Persist one AIMessage row per scan with kind="detector". This is the
  // source of truth for detector by-model + cost aggregations in the hourly
  // billing cron — same role aIMessage plays for chat + RCA.
  const usages = fulfilled.map((o) => o.usage).filter((u): u is ScanUsage => u !== null);
  if (usages.length > 0 && workspaceId) {
    const aiMessageRows = usages.map((u) => ({
      workspaceId,
      sessionId: null,
      kind: "detector",
      role: "assistant",
      content: "", // detector scans don't have a chat-like content payload
      model: u.inferenceModel,
      provider: u.inferenceProvider,
      isByok: u.inferenceSource === "byok",
      inputTokens: u.inferenceInputTokens,
      outputTokens: u.inferenceOutputTokens,
      cost: u.inferenceCost,
    }));
    try {
      await prisma.aIMessage.createMany({ data: aiMessageRows });
    } catch (err) {
      console.error(`[Detector] Failed to write aIMessage rows for trace ${traceId}:`, err);
    }
  }

  const triggered = fulfilled
    .map((o) => o.triggered)
    .filter((t): t is TriggeredResult => t !== null);

  if (triggered.length === 0) {
    if (options.isReeval) {
      await retractStaleFinding(projectId, traceId);
    }
    return;
  }

  // ONE finding per trace — aggregate all triggered detector summaries.
  // findingId is a deterministic hash of (projectId, traceId) so a job retry
  // (BullMQ attempts: 3) lands on the same finding/RCA row instead of creating
  // a duplicate. ClickHouse-level dedup of finding rows is a follow-up
  // (ReplacingMergeTree on finding_id), but Postgres DetectorRca + the RCA
  // queue jobId are now both keyed by this stable id.
  const findingId = traceFindingId(projectId, traceId);
  const combinedSummary = triggered.map((r) => `[${r.detectorName}] ${r.summary}`).join("\n");
  // The read side parses the payload as a JSON array (JSONExtractArrayRaw),
  // so the partial marker lives on each entry rather than on a wrapper object.
  const payload = JSON.stringify(
    triggered.map((r) => ({
      detectorId: r.detectorId,
      detectorName: r.detectorName,
      summary: r.summary,
      data: r.data,
      ...(options.partialReason ? { partial: true } : {}),
    })),
  );

  await writeDetectorFinding({
    findingId,
    projectId,
    traceId,
    summary: combinedSummary,
    payload,
  });

  // Write runs for all triggered detectors, all pointing to the same finding_id
  await Promise.allSettled(
    triggered.map((r) =>
      writeDetectorRun({
        runId: deterministicRunId(projectId, traceId, r.detectorId),
        detectorId: r.detectorId,
        projectId,
        traceId,
        findingId,
        status: "completed",
      }).catch((err) => console.error("[Detector] Failed to write run:", err)),
    ),
  );

  console.log(
    `[Detector] Finding ${findingId} created for trace ${traceId} (${triggered.length} detector(s) triggered)`,
  );

  // RCA is shared per trace. Run it only when at least one triggered detector
  // has RCA enabled; otherwise skip both the seed row and the queue job so a
  // noisy RCA-disabled detector doesn't incur agent-model cost. Consumers
  // null-check an absent DetectorRca record, so skipping the row is safe.
  const rcaFindings: DetectorRcaFinding[] = buildRcaFindings(triggered);

  // A re-eval that triggers for the first time (the initial eval was clean)
  // has no prior RCA and must still create one. Suppress only when an RCA
  // already exists, so overwriting the finding row doesn't spawn a duplicate.
  const rcaExists =
    options.isReeval &&
    (await prisma.detectorRca.findUnique({
      where: { findingId },
      select: { findingId: true },
    })) !== null;

  if (rcaExists) {
    console.log(`[Detector] re-eval overwrite finding=${findingId}`);
  } else if (shouldRunRca(triggered, detectors)) {
    await prisma.detectorRca
      .upsert({
        where: { findingId },
        create: { findingId, projectId, status: "pending" },
        update: { projectId, status: "pending" },
      })
      .catch((e) =>
        console.error(`[Detector] Failed to seed DetectorRca for finding ${findingId}:`, e),
      );

    await getRcaQueue().add(
      `rca-${findingId}`,
      {
        findingId,
        projectId,
        traceId,
        workspaceId,
        projectName,
        findings: rcaFindings,
      },
      { jobId: `rca-${findingId}`, removeOnComplete: 100, removeOnFail: 50 },
    );
  } else {
    console.log(
      `[Detector] All triggered detectors have RCA disabled; skipping RCA for finding ${findingId}`,
    );
  }
}

/**
 * Worker entry point: gate evaluation on the trace having settled, bouncing
 * the job through the delayed set until it has (or a forced-evaluation
 * condition fires). Exported for tests.
 */
export async function handleDetectorRunJob(
  job: Job<DetectorRunJob>,
  token?: string,
): Promise<void> {
  const { traceId, detectorIds, projectId } = job.data;
  if (!detectorIds || detectorIds.length === 0) return;

  // A settle-status fetch failure is transient: throw and let the normal
  // BullMQ retry policy handle it.
  const settle = await fetchSettleStatus(projectId, traceId);
  const decision = decideSettleAction(settle, job.data, Date.now() - job.timestamp);

  if (decision.action === "bounce") {
    await job.updateData(decision.nextData);
    console.log(
      `[Detector] settle-bounce trace=${traceId} bounces=${decision.nextData.bounces} ` +
        `dangling=${settle.dangling_count} age=${settle.last_arrival_age_seconds}s`,
    );
    // moveToDelayed + DelayedError is BullMQ's supported re-delay pattern;
    // unlike a thrown failure, it does not consume an attempt.
    await job.moveToDelayed(Date.now() + decision.delayMs, token);
    throw new DelayedError();
  }

  if (decision.partialReason === "cap_expired") {
    console.log(`[Detector] settle-cap-expired trace=${traceId}`);
  } else if (decision.partialReason === "no_progress") {
    console.log(`[Detector] settle-early-out trace=${traceId} reason=no_progress`);
  }

  await processTrace(traceId, projectId, detectorIds, {
    partialReason: decision.partialReason,
    isReeval: Boolean(job.data.reeval),
  });
}

export function startDetectorRunWorker(): Worker<DetectorRunJob> {
  const connection = createRedisConnection();

  const worker = new Worker<DetectorRunJob>(DETECTOR_RUN_QUEUE, handleDetectorRunJob, {
    connection,
    concurrency: 10,
  });

  worker.on("failed", (job, err) => {
    console.error(`[Detector] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
