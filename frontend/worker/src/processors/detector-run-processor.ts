import { Worker, Queue, type Job } from "bullmq";
import { randomUUID } from "crypto";
import { prisma } from "@traceroot/core";
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
import { sendFindingEmail } from "../notifications/email.js";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

const FLUSH_INTERVAL_MS = 3_000;

// Buffer: key = `${traceId}:${projectId}`, value = array of detectorIds for that trace
const buffer = new Map<string, string[]>();
// Flush timers: key = `${traceId}:${projectId}`
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

let rcaQueue: Queue<DetectorRcaJob>;

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
  emailAddresses: string[];
  autoRca: boolean;
}

/**
 * Run one detector against a trace. Writes the run record immediately for
 * non-triggered and failed cases (finding_id = null). For triggered cases,
 * returns the result WITHOUT writing anything — flushTrace handles the finding
 * write and the run write so all triggered runs share the same finding_id.
 */
async function runSingleDetector(params: {
  detector: {
    id: string;
    name: string;
    prompt: string;
    outputSchema: Array<{ name: string; type: string }>;
    detectionModel: string | null;
    detectionProvider: string | null;
    detectionAdapter: string | null;
    alertConfig: {
      emailAddresses: string[];
      autoRca: boolean;
    } | null;
  };
  traceId: string;
  projectId: string;
  spansJsonl: string;
  workspaceId: string;
}): Promise<TriggeredResult | null> {
  const { detector, traceId, projectId, spansJsonl, workspaceId } = params;
  const runId = randomUUID();

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
        detectionAdapter: detector.detectionAdapter,
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
    return null;
  }

  if (!result.identified) {
    // Not triggered — write run immediately (no finding_id)
    await writeDetectorRun({
      runId,
      detectorId: detector.id,
      projectId,
      traceId,
      findingId: null,
      status: result.error ? "failed" : "completed",
    }).catch((err) => console.error("[Detector] Failed to write run:", err));
    return null;
  }

  // Triggered — return result without writing anything.
  // flushTrace will generate the shared finding_id, write the finding, then write this run.
  console.log(
    `[Detector] Detector ${detector.name} triggered on trace ${traceId}: ${result.summary.slice(0, 80)}`,
  );
  return {
    detectorId: detector.id,
    detectorName: detector.name,
    summary: result.summary,
    data: result.data,
    emailAddresses: detector.alertConfig?.emailAddresses ?? [],
    autoRca: detector.alertConfig?.autoRca ?? false,
  };
}

async function flushTrace(
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
          runId: randomUUID(),
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

  const [detectors, project] = await Promise.all([
    prisma.detector.findMany({
      where: { id: { in: detectorIds }, enabled: true },
      include: { alertConfig: true },
    }),
    prisma.project.findUnique({ where: { id: projectId } }),
  ]);

  const projectName = project?.name ?? "";
  const workspaceId = project?.workspaceId ?? "";

  // Run all detectors in parallel; collect triggered results
  const settled = await Promise.allSettled(
    detectors.map((detector) => {
      const outputSchema = Array.isArray(detector.outputSchema)
        ? (detector.outputSchema as Array<{ name: string; type: string }>)
        : [];
      const alertConfig = detector.alertConfig
        ? {
            emailAddresses: detector.alertConfig.emailAddresses ?? [],
            autoRca: detector.alertConfig.autoRca ?? false,
          }
        : null;

      return runSingleDetector({
        detector: {
          id: detector.id,
          name: detector.name,
          prompt: detector.prompt,
          outputSchema,
          detectionModel: detector.detectionModel,
          detectionProvider: detector.detectionProvider,
          detectionAdapter: detector.detectionAdapter,
          alertConfig,
        },
        traceId,
        projectId,
        spansJsonl,
        workspaceId,
      });
    }),
  );

  const triggered = settled
    .filter(
      (r): r is PromiseFulfilledResult<TriggeredResult> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);

  if (triggered.length === 0) return;

  // ONE finding per trace — aggregate all triggered detector summaries
  const findingId = randomUUID();
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
        runId: randomUUID(),
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

  // Detectors with autoRca=false → send immediate per-detector emails
  for (const r of triggered.filter((t) => !t.autoRca)) {
    if (r.emailAddresses.length === 0) continue;
    sendFindingEmail({
      to: r.emailAddresses,
      detectorName: r.detectorName,
      projectName,
      summary: r.summary,
      traceId,
      projectId,
    }).catch((e) =>
      console.error(`[Detector] Immediate email failed for finding ${findingId}:`, e),
    );
  }

  // Detectors with autoRca=true → ONE combined RCA job for the whole trace
  const rcaTriggered = triggered.filter((r) => r.autoRca);
  if (rcaTriggered.length > 0) {
    const emailAddresses = [...new Set(rcaTriggered.flatMap((r) => r.emailAddresses))];
    const rcaFindings: DetectorRcaFinding[] = rcaTriggered.map((r) => ({
      detectorId: r.detectorId,
      detectorName: r.detectorName,
      summary: r.summary,
    }));

    await prisma.detectorRca
      .upsert({
        where: { findingId },
        create: { findingId, status: "pending" },
        update: { status: "pending" },
      })
      .catch((e) =>
        console.error(`[Detector] Failed to seed DetectorRca for finding ${findingId}:`, e),
      );

    await rcaQueue.add(
      `rca-${findingId}`,
      {
        findingId,
        projectId,
        traceId,
        workspaceId,
        projectName,
        findings: rcaFindings,
        emailAddresses,
      },
      { jobId: `rca-${findingId}`, removeOnComplete: 100, removeOnFail: 50 },
    );
  }
}

export function startDetectorRunWorker(): Worker<DetectorRunJob> {
  const connection = createRedisConnection();
  rcaQueue = new Queue<DetectorRcaJob>(DETECTOR_RCA_QUEUE, {
    connection: createRedisConnection(),
  });

  const worker = new Worker<DetectorRunJob>(
    DETECTOR_RUN_QUEUE,
    async (job: Job<DetectorRunJob>) => {
      const { traceId, detectorId, projectId } = job.data;
      const traceKey = `${traceId}:${projectId}`;

      if (!buffer.has(traceKey)) buffer.set(traceKey, []);
      buffer.get(traceKey)!.push(detectorId);

      // Cancel existing timer and set a fresh window
      const existing = flushTimers.get(traceKey);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        const detectorIds = buffer.get(traceKey);
        buffer.delete(traceKey);
        flushTimers.delete(traceKey);

        if (!detectorIds || detectorIds.length === 0) return;

        flushTrace(traceId, projectId, detectorIds).catch((e) =>
          console.error(`[Detector] flushTrace error for trace ${traceKey}:`, e),
        );
      }, FLUSH_INTERVAL_MS);

      flushTimers.set(traceKey, timer);
    },
    { connection, concurrency: 10 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[Detector] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
