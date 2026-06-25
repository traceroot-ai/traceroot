import { Worker } from "bullmq";
import { prisma } from "@traceroot/core";
import type { DigestEntry } from "@traceroot/slack";
import {
  DETECTOR_DIGEST_QUEUE,
  type DigestFlushJob,
  createRedisConnection,
} from "../queues/digest-queue.js";
import {
  readDetectorCounts,
  readLatestFinding,
  type DetectorCounts,
} from "../detection/findings-reader.js";
import { sendDigestAlertSlack } from "../notifications/slack.js";
import { sendDigestAlertEmail } from "../notifications/email.js";

/**
 * Flush one project's alert window: read the per-detector finding counts in
 * `[windowStart, windowStart + windowMs)`, build one digest grouped by
 * detector, and fan it out to every configured channel (Slack + email).
 *
 * The digest covers RCA-enabled detectors only — a deliberate v1 narrowing.
 * Per-detector window counts carry no per-trace co-trigger info, so an
 * RCA-disabled detector is dropped even when it co-triggered with an RCA-enabled
 * one on the same trace. We err toward fewer alerts; per-trace precision is a
 * follow-up.
 */
export async function flushDigest(job: DigestFlushJob): Promise<void> {
  const { projectId, windowStart, windowMs } = job;
  const start = new Date(windowStart);
  const end = new Date(windowStart + windowMs);

  const counts = await readDetectorCounts(projectId, start, end);
  const triggeredIds = Object.keys(counts).filter((id) => counts[id].finding_count > 0);
  if (triggeredIds.length === 0) return; // nothing triggered in the window

  // Per-detector name + RCA-enabled flag; drop RCA-disabled detectors.
  const detectors = await prisma.detector.findMany({
    where: { id: { in: triggeredIds } },
    select: { id: true, name: true, enableRca: true },
  });
  const nameById = new Map(detectors.map((d) => [d.id, d.name]));
  const rcaEnabled = new Set(detectors.filter((d) => d.enableRca).map((d) => d.id));
  const detectorIds = triggeredIds.filter((id) => rcaEnabled.has(id));
  if (detectorIds.length === 0) return; // only RCA-disabled detectors fired → no digest

  const entries = await buildEntries(projectId, detectorIds, nameById, counts, start, end);
  const total = entries.reduce((sum, e) => sum + e.findingCount, 0);

  await fanOut({ projectId, windowStart: start, windowEnd: end, total, entries });
}

/**
 * Build one digest entry per detector, fetching each detector's latest trace in
 * the window concurrently (one round-trip each).
 */
async function buildEntries(
  projectId: string,
  detectorIds: string[],
  nameById: Map<string, string>,
  counts: DetectorCounts,
  start: Date,
  end: Date,
): Promise<DigestEntry[]> {
  return Promise.all(
    detectorIds.map(async (id) => ({
      detectorId: id,
      detectorName: nameById.get(id) ?? id,
      findingCount: counts[id].finding_count,
      latestTraceId: (await readLatestFinding(projectId, id, start, end)) ?? "",
    })),
  );
}

interface DigestContent {
  projectId: string;
  windowStart: Date;
  windowEnd: Date;
  total: number;
  entries: DigestEntry[];
}

/**
 * Resolve recipients/token fresh at flush time and fan the digest out to every
 * configured channel (Slack + email). Per-channel failures are logged, never
 * thrown, so one channel can't block the other.
 */
async function fanOut(content: DigestContent): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: content.projectId },
    select: {
      name: true,
      alertConfig: { select: { emailAddresses: true, slackChannelId: true } },
      workspace: {
        select: { id: true, slackIntegration: { select: { channelId: true, botToken: true } } },
      },
    },
  });
  if (!project) return;

  const slack = project.workspace?.slackIntegration ?? null;
  const slackChannelId = project.alertConfig?.slackChannelId ?? slack?.channelId ?? null;
  const emailAddresses = project.alertConfig?.emailAddresses ?? [];
  const payload = { ...content, projectName: project.name };

  const tasks: Promise<unknown>[] = [];
  if (slackChannelId && slack?.botToken) {
    tasks.push(
      sendDigestAlertSlack({
        workspaceId: project.workspace!.id,
        encryptedBotToken: slack.botToken,
        channelId: slackChannelId,
        ...payload,
      }).catch((e) =>
        console.error(`[Digest] Slack send failed for project ${content.projectId}:`, e),
      ),
    );
  }
  if (emailAddresses.length > 0) {
    tasks.push(
      sendDigestAlertEmail({ to: emailAddresses, ...payload }).catch((e) =>
        console.error(`[Digest] Email send failed for project ${content.projectId}:`, e),
      ),
    );
  }
  await Promise.allSettled(tasks);
}

export function startDetectorDigestWorker(): Worker<DigestFlushJob> {
  const worker = new Worker<DigestFlushJob>(
    DETECTOR_DIGEST_QUEUE,
    async (job) => flushDigest(job.data),
    { connection: createRedisConnection(), concurrency: 3 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[Digest] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
