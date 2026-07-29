import { Worker } from "bullmq";
import { prisma, PlanType } from "@traceroot/core";
import type { DigestEntry } from "@traceroot/slack";
import {
  DETECTOR_DIGEST_QUEUE,
  type DigestFlushJob,
  createRedisConnection,
} from "../queues/digest-queue.js";
import {
  readDetectorWindowSummary,
  type DetectorWindowSummary,
} from "../detection/findings-reader.js";
import { sendDigestAlertSlack } from "../notifications/slack.js";
import { sendDigestAlertEmail } from "../notifications/email.js";
import { generateDigestSummary } from "../notifications/digest-summary.js";

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
  // A flush has several no-op exits (no channels, nothing triggered, only
  // RCA-disabled fired). A successful send is otherwise silent, so log every
  // exit with its reason — in prod this is the only record of whether a given
  // window's digest fired, to whom, and why it didn't.
  const window = `[${start.toISOString()},${end.toISOString()})`;

  // Resolve alert channels first: a project with no Slack channel and no email
  // recipients has nowhere to send, so skip the count + per-detector reads for a
  // digest that would fan out to nowhere.
  const recipients = await resolveRecipients(projectId);
  if (!recipients) {
    console.log(`[Digest] skip project=${projectId} window=${window} reason=no-channels`);
    return;
  }

  // Gates resolved before the read so blocked workspaces never pay for the
  // summaries join. Kill switch: summaries are enabled unless the env var says
  // "false" (case/whitespace-insensitive, same idiom as ENABLE_BILLING). Free-
  // plan gate mirrors RCA so blocked workspaces spend no LLM tokens.
  const summariesKilled =
    (process.env.DIGEST_SUMMARY_ENABLED ?? "").trim().toLowerCase() === "false";
  const summaryAllowed =
    !summariesKilled && !(recipients.rcaBlocked && recipients.billingPlan === PlanType.FREE);
  const summary = await readDetectorWindowSummary(projectId, start, end, {
    includeSummaries: summaryAllowed,
  });
  const triggeredIds = Object.keys(summary).filter((id) => summary[id].finding_count > 0);
  if (triggeredIds.length === 0) {
    console.log(`[Digest] skip project=${projectId} window=${window} reason=no-findings`);
    return; // nothing triggered in the window
  }

  // Per-detector name + RCA-enabled flag; drop RCA-disabled detectors.
  const detectors = await prisma.detector.findMany({
    where: { id: { in: triggeredIds } },
    select: { id: true, name: true, enableRca: true },
  });
  const nameById = new Map(detectors.map((d) => [d.id, d.name]));
  const rcaEnabled = new Set(detectors.filter((d) => d.enableRca).map((d) => d.id));
  const detectorIds = triggeredIds.filter((id) => rcaEnabled.has(id));
  if (detectorIds.length === 0) {
    console.log(`[Digest] skip project=${projectId} window=${window} reason=only-rca-disabled`);
    return; // only RCA-disabled detectors fired → no digest
  }

  const entries = buildEntries(detectorIds, nameById, summary);
  const total = entries.reduce((sum, e) => sum + e.findingCount, 0);

  // Best-effort LLM paragraph. Never blocks the digest: any failure inside
  // generateDigestSummary resolves to null and the digest sends as before.
  // summaryAllowed was computed above (kill switch + free-plan RCA gate).
  let digestSummary: string | undefined;
  if (summaryAllowed) {
    const result = await generateDigestSummary(
      {
        projectName: recipients.projectName,
        windowStart: start,
        windowEnd: end,
        detectors: detectorIds.map((id) => ({
          name: nameById.get(id) ?? id,
          findingCount: summary[id].finding_count,
          sampleSummaries: summary[id].sample_summaries ?? [],
        })),
      },
      {
        workspaceId: recipients.workspaceId,
        rcaModel: recipients.rcaModel,
        rcaProvider: recipients.rcaProvider,
        rcaSource: recipients.rcaSource,
      },
    );
    if (result) {
      digestSummary = result.summary;
      // Bookkeeping/observability only: usage metering (usageMetering.ts,
      // MessageKind = chat|rca|detector) intentionally does NOT meter
      // "digest-summary" in v1; extending metering is a documented follow-up.
      await prisma.aIMessage
        .create({
          data: {
            workspaceId: recipients.workspaceId,
            sessionId: null,
            kind: "digest-summary",
            role: "assistant",
            content: "",
            model: result.usage.model,
            provider: result.usage.provider,
            isByok: result.usage.isByok,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cost: result.usage.cost,
          },
        })
        .catch((err) =>
          console.error(`[Digest] Failed to write digest-summary aIMessage for ${projectId}:`, err),
        );
    }
  } else {
    console.log(
      `[Digest] skip summary project=${projectId} reason=${summariesKilled ? "kill-switch" : "rca-blocked-free-plan"}`,
    );
  }

  await fanOut(recipients, {
    projectId,
    windowStart: start,
    windowEnd: end,
    total,
    entries,
    summary: digestSummary,
  });

  // Per-channel failures are caught inside fanOut and don't reach here, so this
  // line means the digest was handed to every configured channel.
  console.log(
    `[Digest] sent project=${projectId} window=${window} findings=${total} ` +
      `detectors=${entries.length} slack=${recipients.slackChannelId ? "yes" : "no"} ` +
      `email=${recipients.emailAddresses.length} summary=${digestSummary ? "yes" : "no"}`,
  );
}

/**
 * Build one digest entry per detector. The window-summary read already carries
 * each detector's sample triggered traces (folded into the endpoint), so no
 * per-detector round-trip is needed. The entry shows the newest one today.
 */
function buildEntries(
  detectorIds: string[],
  nameById: Map<string, string>,
  summary: DetectorWindowSummary,
): DigestEntry[] {
  return detectorIds.map((id) => ({
    detectorId: id,
    detectorName: nameById.get(id) ?? id,
    findingCount: summary[id].finding_count,
    latestTraceId: summary[id].sample_trace_ids[0] ?? "",
  }));
}

interface DigestContent {
  projectId: string;
  windowStart: Date;
  windowEnd: Date;
  total: number;
  entries: DigestEntry[];
  summary?: string;
}

interface DigestRecipients {
  projectName: string;
  workspaceId: string;
  slackChannelId: string | null;
  encryptedBotToken: string | null;
  emailAddresses: string[];
  billingPlan: string;
  rcaBlocked: boolean;
  rcaModel: string | null;
  rcaProvider: string | null;
  rcaSource: string | null;
}

/**
 * Resolve the project's alert channels once, up front. Returns null when the
 * project is gone or has nothing configured (no Slack channel + bot token, no
 * email recipients), so the caller can skip the rest of the flush for a digest
 * that would fan out to nowhere.
 */
async function resolveRecipients(projectId: string): Promise<DigestRecipients | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      name: true,
      rcaModel: true,
      rcaProvider: true,
      rcaSource: true,
      alertConfig: { select: { emailAddresses: true, slackChannelId: true } },
      workspace: {
        select: {
          id: true,
          billingPlan: true,
          rcaBlocked: true,
          slackIntegration: { select: { channelId: true, botToken: true } },
        },
      },
    },
  });
  if (!project) return null;

  const slack = project.workspace?.slackIntegration ?? null;
  const slackChannelId = project.alertConfig?.slackChannelId ?? slack?.channelId ?? null;
  const slackReady = Boolean(slackChannelId && slack?.botToken);
  const emailAddresses = project.alertConfig?.emailAddresses ?? [];
  if (!slackReady && emailAddresses.length === 0) return null; // nowhere to send

  return {
    projectName: project.name,
    workspaceId: project.workspace!.id,
    slackChannelId: slackReady ? slackChannelId : null,
    encryptedBotToken: slackReady ? slack!.botToken : null,
    emailAddresses,
    billingPlan: (project.workspace?.billingPlan as string) ?? "free",
    rcaBlocked: project.workspace?.rcaBlocked ?? false,
    rcaModel: project.rcaModel,
    rcaProvider: project.rcaProvider,
    rcaSource: project.rcaSource,
  };
}

/**
 * Fan the digest out to every configured channel (Slack + email) using the
 * already-resolved recipients. Per-channel failures are logged, never thrown,
 * so one channel can't block the other.
 */
async function fanOut(recipients: DigestRecipients, content: DigestContent): Promise<void> {
  const payload = { ...content, projectName: recipients.projectName };

  const tasks: Promise<unknown>[] = [];
  if (recipients.slackChannelId && recipients.encryptedBotToken) {
    tasks.push(
      sendDigestAlertSlack({
        workspaceId: recipients.workspaceId,
        encryptedBotToken: recipients.encryptedBotToken,
        channelId: recipients.slackChannelId,
        ...payload,
      }).catch((e) =>
        console.error(`[Digest] Slack send failed for project ${content.projectId}:`, e),
      ),
    );
  }
  if (recipients.emailAddresses.length > 0) {
    tasks.push(
      sendDigestAlertEmail({ to: recipients.emailAddresses, ...payload }).catch((e) =>
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
