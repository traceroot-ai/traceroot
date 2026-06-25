import { Worker } from "bullmq";
import { prisma } from "@traceroot/core";
import type { DigestEntry } from "@traceroot/slack";
import {
  DETECTOR_DIGEST_QUEUE,
  type DigestFlushJob,
  createRedisConnection,
} from "../queues/digest-queue.js";
import { readDetectorCounts, readLatestFinding } from "../detection/findings-reader.js";
import { sendDigestAlertSlack } from "../notifications/slack.js";
import { sendDigestAlertEmail } from "../notifications/email.js";

/**
 * Flush one project's alert window: read the per-detector finding counts in
 * `[windowStart, windowStart + windowMs)`, build one digest grouped by
 * detector, and fan it out to every configured channel (Slack + email).
 *
 * The digest covers RCA-enabled detectors only — the same invariant as the
 * immediate path, which alerts solely from the RCA worker — so detectors with
 * `enableRca === false` are dropped here.
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

  const entries: DigestEntry[] = [];
  let total = 0;
  for (const id of detectorIds) {
    const findingCount = counts[id].finding_count;
    total += findingCount;
    const latestTraceId = (await readLatestFinding(projectId, id, start, end)) ?? "";
    entries.push({
      detectorId: id,
      detectorName: nameById.get(id) ?? id,
      findingCount,
      latestTraceId,
    });
  }

  // Re-resolve recipients/token fresh — identical select to the RCA processor.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
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

  const window = {
    projectId,
    projectName: project.name,
    windowStart: start,
    windowEnd: end,
    total,
    entries,
  };

  const tasks: Promise<unknown>[] = [];
  if (slackChannelId && slack?.botToken) {
    tasks.push(
      sendDigestAlertSlack({
        workspaceId: project.workspace!.id,
        encryptedBotToken: slack.botToken,
        channelId: slackChannelId,
        ...window,
      }).catch((e) => console.error(`[Digest] Slack send failed for project ${projectId}:`, e)),
    );
  }
  if (emailAddresses.length > 0) {
    tasks.push(
      sendDigestAlertEmail({ to: emailAddresses, ...window }).catch((e) =>
        console.error(`[Digest] Email send failed for project ${projectId}:`, e),
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
