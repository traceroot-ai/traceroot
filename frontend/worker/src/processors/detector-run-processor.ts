import { Worker, Queue, DelayedError, type Job } from "bullmq";
import { createHash } from "crypto";
import { prisma, PlanType } from "@traceroot/core";
import type {
  DetectorRunJob,
  DetectorRcaJob,
  DetectorRcaFinding,
} from "../queues/detector-run-queue.js";
import {
  DETECTOR_RUN_QUEUE,
  DETECTOR_RCA_QUEUE,
  EVALUATOR_DELAY,
  createRedisConnection,
} from "../queues/detector-run-queue.js";
import { runDetectionForTrace } from "../detection/sandbox-eval.js";
import { writeDetectorRun, writeDetectorFinding } from "../detection/clickhouse-writer.js";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

/**
 * Returns the AGE of the trace's most recent span arrival in milliseconds —
 * i.e. how long the trace has been quiet (now − last span), NOT an absolute
 * epoch timestamp. The worker evaluates once this age reaches EVALUATOR_DELAY
 * (a simple quiescence debounce). The age is computed inside ClickHouse
 * (now64() vs max(ch_create_time)) to avoid cross-service clock skew.
 */
async function fetchLastArrivalTimestampMs(projectId: string, traceId: string): Promise<number> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/internal/traces/${traceId}/settle-status?project_id=${projectId}`,
    { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch settle status for trace ${traceId}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { last_arrival_age_seconds: number };
  return body.last_arrival_age_seconds * 1000;
}

/** Hash a string to a uuid-shaped id (first 128 bits of sha256, 8-4-4-4-12). */
function hashToUuid(input: string): string {
  return createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

/**
 * Deterministic run id keyed on (projectId, traceId, detectorId).
 * On a BullMQ retry, the same triple lands on the same runId — so re-writes
 * collapse with detector_findings.findingId rather than producing duplicate
 * run rows for the same (detector, trace).
 */
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
}): Promise<SingleDetectorOutcome> {
  const { detector, traceId, projectId, spansJsonl, workspaceId } = params;
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

export async function processTrace(
  traceId: string,
  projectId: string,
  detectorIds: string[],
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

  await evaluateTrace(traceId, projectId, detectorIds, spansJsonl);
}

async function evaluateTrace(
  traceId: string,
  projectId: string,
  detectorIds: string[],
  spansJsonl: string,
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

  if (triggered.length === 0) return;

  // ONE finding per trace — aggregate all triggered detector summaries.
  // findingId is a deterministic hash of (projectId, traceId) so a job retry
  // lands on the same finding/RCA row instead of creating
  // a duplicate. ClickHouse-level dedup of finding rows is a follow-up
  // (ReplacingMergeTree on finding_id), but Postgres DetectorRca + the RCA
  // queue jobId are now both keyed by this stable id.
  const findingId = traceFindingId(projectId, traceId);
  const combinedSummary = triggered.map((r) => `[${r.detectorName}] ${r.summary}`).join("\n");
  const payload = JSON.stringify(
    triggered.map((r) => ({
      detectorId: r.detectorId,
      detectorName: r.detectorName,
      summary: r.summary,
      data: r.data,
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

  if (shouldRunRca(triggered, detectors)) {
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
 * Worker entry point: evaluate the trace once it has gone quiet for
 * EVALUATOR_DELAY (no span ingested for that long). Otherwise re-delay the job
 * to fire exactly EVALUATOR_DELAY after the most recent span and re-check.
 * Exported for tests.
 */
export async function handleDetectorRunJob(
  job: Job<DetectorRunJob>,
  token?: string,
): Promise<void> {
  const { traceId, detectorIds, projectId } = job.data;
  if (!detectorIds || detectorIds.length === 0) return;

  // A settle-status fetch failure is transient: throw and let the normal
  // BullMQ retry policy handle it.
  const lastArrivalAgeMs = await fetchLastArrivalTimestampMs(projectId, traceId);

  if (lastArrivalAgeMs >= EVALUATOR_DELAY) {
    await processTrace(traceId, projectId, detectorIds);
    return;
  }

  // Not quiet yet — sleep until exactly EVALUATOR_DELAY after the most recent
  // span, then re-check. moveToDelayed + DelayedError is BullMQ's supported
  // re-delay pattern; unlike a thrown failure it does not consume an attempt.
  const delayMs = EVALUATOR_DELAY - lastArrivalAgeMs;
  console.log(
    `[Detector] settle-wait trace=${traceId} quiet=${Math.round(lastArrivalAgeMs / 1000)}s ` +
      `re-check in ${Math.round(delayMs / 1000)}s`,
  );
  await job.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

export function startDetectorRunWorker(): Worker<DetectorRunJob> {
  const connection = createRedisConnection();

  const worker = new Worker<DetectorRunJob>(DETECTOR_RUN_QUEUE, handleDetectorRunJob, {
    connection,
    concurrency: 10,
  });

  worker.on("failed", (job, err) => {
    // DelayedError is BullMQ's re-delay control signal (thrown on every
    // quiescence re-check), not a real failure — ignore it so routine
    // re-delays never pollute error monitoring.
    if (err instanceof DelayedError) return;
    console.error(`[Detector] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
