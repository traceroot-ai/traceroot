import { Queue, Worker } from "bullmq";
import {
  decryptKey,
  hasEntitlement,
  prisma,
  type AlertStatus,
  type PlanType,
} from "@traceroot/core";
import { buildAlertBlocks, createSlackClient, type WebClient } from "@traceroot/slack";
import {
  ALERT_NOTIFICATION_QUEUE,
  alertNotificationBackoff,
  createAlertNotificationQueue,
  createRedisConnection,
  type AlertEmissionClaim,
  type AlertNotification,
  type AlertNotificationJob,
} from "../queues/alert-notification-queue.js";
import {
  recordAlertNotifyOutcome,
  type AlertNotifyOutcome,
  type AlertNotifyStatus,
} from "../alerts/claim.js";
import { revertAlertEmission } from "../alerts/emission.js";
import { logError, logInfo } from "../alerts/log.js";

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

type SlackAttachments = Extract<
  NonNullable<Parameters<WebClient["chat"]["postMessage"]>[0]>,
  { attachments: unknown }
>["attachments"];

let notificationQueue: Queue<AlertNotificationJob> | null = null;
function getNotificationQueue(): Queue<AlertNotificationJob> {
  if (!notificationQueue) {
    // A producer connection must not retry forever: an unfailable command is one the
    // caller can never compensate for.
    notificationQueue = createAlertNotificationQueue(
      createRedisConnection({ maxRetriesPerRequest: 3 }),
    );
  }
  return notificationQueue;
}

const ENQUEUE_ATTEMPTS = 3;
const ENQUEUE_RETRY_DELAY_MS = 200;
const ENQUEUE_TIMEOUT_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ioredis buffers commands issued while disconnected, so an `add` during an outage never
 * settles, and the tick is one awaited chain: it stops every remaining rule on the platform.
 */
async function addWithTimeout(id: string, job: AlertNotificationJob): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms for ${id}`)),
      ENQUEUE_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([getNotificationQueue().add(id, job, { jobId: id }), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The queue's `attempts` only cover a job that has landed in Redis, so a brief outage would
 * drop it. The jobId is the alert and its window, which BullMQ dedupes on, so no double-page.
 */
export async function enqueueAlertNotification(payload: AlertNotification): Promise<void> {
  const job: AlertNotificationJob = {
    ...payload,
    windowStart: payload.windowStart.getTime(),
    windowEnd: payload.windowEnd.getTime(),
  };
  const id = `alert-${job.alertId}-${job.windowEnd}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      await addWithTimeout(id, job);
      return;
    } catch (error) {
      lastError = error;
      logError(`enqueue attempt ${attempt}/${ENQUEUE_ATTEMPTS} failed for ${id}`, error);
      if (attempt < ENQUEUE_ATTEMPTS) await delay(ENQUEUE_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`alert notification enqueue failed for ${id}`);
}

const ACTIVE: AlertStatus = "ACTIVE";

/** A blocked job carries the outcome to record, since what to record is why it is blocked. */
type AlertSendCheck = { ok: true } | { ok: false; outcome: AlertNotifyOutcome };

function blocked(
  alertId: string,
  status: AlertNotifyStatus,
  reason: string,
  notAfter?: Date,
): AlertSendCheck {
  return { ok: false, outcome: { alertId, status, error: reason, at: new Date(), notAfter } };
}

/**
 * The emission this job carries is the current one exactly when the rule still
 * reads as that emission left it: every emission stamps `alertedAt` with the
 * boundary it evaluated, which is what the compensation matches on too.
 */
function isCurrentEmission(
  alert: { severity: string; alertedAt: Date | null },
  payload: AlertNotificationJob,
  emission: AlertEmissionClaim,
): boolean {
  return alert.severity === payload.severity && alert.alertedAt?.getTime() === emission.evaluatedAt;
}

/**
 * Both ways a job can arrive too late, in the one read it already made. A rule the
 * owner paused or deleted while this job waited out a backoff must not page, and its
 * state is not rolled back either: pausing is itself a thing that happened to the
 * alert, and a deleted rule has nothing left to re-emit.
 *
 * Nor may a job send for an emission a later evaluation has replaced. Attempts run
 * out to half an hour, so a recovery still retrying while the breach returns would
 * otherwise leave "recovered" as the channel's last word on a rule in ALERT. That is
 * also what makes the kill switch safe to cycle: the queue has no TTL, so a restart
 * replays jobs against windows hours old. Nothing is rolled back here either — the
 * state belongs to the emission that replaced this one.
 */
async function checkAlertStillSendable(payload: AlertNotificationJob): Promise<AlertSendCheck> {
  const alert = await prisma.alert.findUnique({
    where: { id: payload.alertId },
    select: { status: true, severity: true, alertedAt: true },
  });
  if (alert === null) return blocked(payload.alertId, "FAILED", "alert-deleted");
  if (alert.status !== ACTIVE) return blocked(payload.alertId, "FAILED", "alert-paused");

  // A job enqueued before the claim travelled cannot be placed against the row, so
  // it is delivered on the same terms it was queued under.
  const { emission } = payload;
  if (emission !== undefined && !isCurrentEmission(alert, payload, emission)) {
    return blocked(payload.alertId, "SUPERSEDED", "superseded", new Date(emission.evaluatedAt));
  }
  return { ok: true };
}

interface AlertSlackTarget {
  channelId: string;
  encryptedBotToken: string;
}

type ChannelResolution = { ok: true; target: AlertSlackTarget } | { ok: false; reason: string };

/**
 * A project-level channel overrides the workspace default, matching the detector
 * digest. Every miss carries a reason: a send that quietly does nothing is invisible.
 */
async function resolveAlertChannel(projectId: string): Promise<ChannelResolution> {
  // Re-checked here, not just at claim time: a deleted project must not be linked to in Slack.
  const project = await prisma.project.findUnique({
    where: { id: projectId, deleteTime: null },
    select: {
      alertConfig: { select: { slackChannelId: true } },
      workspace: {
        select: {
          billingPlan: true,
          slackIntegration: { select: { channelId: true, botToken: true } },
        },
      },
    },
  });
  if (!project) return { ok: false, reason: "project-missing" };

  const plan = (project.workspace?.billingPlan ?? "free") as PlanType;
  if (!hasEntitlement(plan, "slack-integration")) {
    return { ok: false, reason: `no-entitlement plan=${plan}` };
  }

  const slack = project.workspace?.slackIntegration ?? null;
  const channelId = project.alertConfig?.slackChannelId ?? slack?.channelId ?? null;
  if (!channelId) return { ok: false, reason: "no-channel" };
  if (!slack?.botToken) return { ok: false, reason: "no-bot-token" };

  return { ok: true, target: { channelId, encryptedBotToken: slack.botToken } };
}

// Errors Slack recovers from itself. Any other is config or payload: retrying changes nothing.
const TRANSIENT_PLATFORM_ERRORS = new Set([
  "ratelimited",
  "rate_limited",
  "internal_error",
  "service_unavailable",
  "fatal_error",
  "request_timeout",
]);

const RATE_LIMITED_CODE = "slack_webapi_rate_limited";

interface SlackErrorShape {
  code?: unknown;
  statusCode?: unknown;
  data?: { error?: unknown };
}

export function isRetryableSlackError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  const shape = error as SlackErrorShape;

  if (shape.code === RATE_LIMITED_CODE) return true;
  if (typeof shape.statusCode === "number") {
    if (shape.statusCode === 429 || shape.statusCode >= 500) return true;
    if (shape.statusCode >= 400) return false;
  }
  const platformError = shape.data?.error;
  if (typeof platformError === "string") return TRANSIENT_PLATFORM_ERRORS.has(platformError);

  // Network faults and anything unrecognized: retry rather than drop the alert.
  return true;
}

/**
 * A job that ends without a message leaves the rule recording a page nobody received, and
 * with renotify off that transition never comes round again — so the emitted severity is
 * rolled back and the next tick emits afresh. Only for a failure a later emission could
 * get past: retryable ones are rethrown while attempts remain, and the permanent ones
 * below are recorded rather than rolled back.
 */
async function revertEmission(payload: AlertNotificationJob, reason: string): Promise<boolean> {
  const { emission } = payload;
  if (emission === undefined) return false;

  try {
    return await revertAlertEmission(
      {
        alertId: payload.alertId,
        emittedSeverity: payload.severity,
        emittedAt: new Date(emission.evaluatedAt),
        priorState: {
          severity: emission.priorSeverity,
          severityChangedAt:
            emission.priorSeverityChangedAt === null
              ? null
              : new Date(emission.priorSeverityChangedAt),
          alertedAt: emission.priorAlertedAt === null ? null : new Date(emission.priorAlertedAt),
        },
      },
      payload.projectId,
      reason,
    );
  } catch (error) {
    logError(`state revert failed alert=${payload.alertId} project=${payload.projectId}`, error);
    return false;
  }
}

async function compensateNonDelivery(payload: AlertNotificationJob, reason: string): Promise<void> {
  const compensated = await revertEmission(payload, reason);
  // A failed revert leaves the rule reading as paged, a different thing to tell the owner.
  await recordAlertNotifyOutcome({
    alertId: payload.alertId,
    status: compensated ? "COMPENSATED" : "FAILED",
    error: reason,
    at: new Date(),
  });
}

/**
 * Delivery that no retry and no re-emission can get past: the rule's channel is
 * misconfigured, not failing. Rolling one of these back would restore exactly the
 * severity `shouldEmit` needs, so the next tick emits the same breach into the same
 * wall — a row write, a rollback and a job every minute, for as long as the breach
 * lasts, and never a page. A rule saved without Slack connected reaches this on its
 * first breach. So it is recorded the way `alert-paused` is: the outcome lands on
 * the row, the severity stays where the evaluation put it, and the owner reads a
 * rule in ALERT whose notification says which setting to go and fix.
 */
const PERMANENT_DELIVERY_FAILURES = new Set([
  "no-channel",
  "no-bot-token",
  "bot-token-undecryptable",
  "permanent-slack-error",
]);

// Carries the plan it was refused for, so it is a prefix rather than a member.
const NO_ENTITLEMENT = "no-entitlement";

function isPermanentDeliveryFailure(reason: string): boolean {
  return PERMANENT_DELIVERY_FAILURES.has(reason) || reason.startsWith(NO_ENTITLEMENT);
}

/** The one place the two kinds of non-delivery are told apart. */
async function recordNonDelivery(payload: AlertNotificationJob, reason: string): Promise<void> {
  if (!isPermanentDeliveryFailure(reason)) {
    await compensateNonDelivery(payload, reason);
    return;
  }
  await recordAlertNotifyOutcome({
    alertId: payload.alertId,
    status: "FAILED",
    error: reason,
    at: new Date(),
  });
}

export async function sendAlertNotification(payload: AlertNotificationJob): Promise<void> {
  const tag = `alert=${payload.alertId} project=${payload.projectId} severity=${payload.severity}`;

  const sendable = await checkAlertStillSendable(payload);
  if (!sendable.ok) {
    logInfo(`slack skip ${tag} reason=${sendable.outcome.error}`);
    await recordAlertNotifyOutcome(sendable.outcome);
    return;
  }

  const resolution = await resolveAlertChannel(payload.projectId);
  if (!resolution.ok) {
    logInfo(`slack skip ${tag} reason=${resolution.reason}`);
    await recordNonDelivery(payload, resolution.reason);
    return;
  }

  let botToken: string;
  try {
    botToken = decryptKey(resolution.target.encryptedBotToken);
  } catch (error) {
    logError(`slack skip ${tag} reason=bot-token-undecryptable`, error);
    await recordNonDelivery(payload, "bot-token-undecryptable");
    return;
  }

  const message = buildAlertBlocks({
    appBaseUrl: APP_BASE_URL,
    projectId: payload.projectId,
    alertId: payload.alertId,
    name: payload.name,
    severity: payload.severity,
    previousSeverity: payload.previousSeverity,
    value: payload.value,
    threshold: payload.threshold,
    thresholdOperator: payload.thresholdOperator,
    measure: payload.measure,
    aggregation: payload.aggregation,
    window: payload.window,
    windowStart: new Date(payload.windowStart),
    windowEnd: new Date(payload.windowEnd),
  });

  try {
    await createSlackClient(botToken).chat.postMessage({
      channel: resolution.target.channelId,
      attachments: [{ color: message.color, blocks: message.blocks }] as SlackAttachments,
      text: message.text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    if (!isRetryableSlackError(error)) {
      logError(`slack dropped ${tag} reason=permanent-slack-error`, error);
      await recordNonDelivery(payload, "permanent-slack-error");
      return;
    }
    throw error;
  }

  logInfo(`slack sent ${tag} channel=${resolution.target.channelId}`);
  await recordAlertNotifyOutcome({
    alertId: payload.alertId,
    status: "DELIVERED",
    error: null,
    at: new Date(),
  });
}

export function startAlertNotificationWorker(): Worker<AlertNotificationJob> {
  const worker = new Worker<AlertNotificationJob>(
    ALERT_NOTIFICATION_QUEUE,
    async (job) => sendAlertNotification(job.data),
    {
      connection: createRedisConnection(),
      concurrency: 5,
      settings: { backoffStrategy: (attemptsMade) => alertNotificationBackoff(attemptsMade) },
    },
  );

  worker.on("failed", (job, err) => {
    logError(`slack job ${job?.id} failed (attempt ${job?.attemptsMade ?? 0}): ${err.message}`);

    // The job's own budget, not the current constant: an older job is exhausted at its own.
    const attempts = job?.opts?.attempts ?? 1;
    const isExhausted = (job?.attemptsMade ?? 0) >= attempts;
    if (!isExhausted || job?.data === undefined) return;
    void recordNonDelivery(job.data, "retries-exhausted");
  });

  return worker;
}
