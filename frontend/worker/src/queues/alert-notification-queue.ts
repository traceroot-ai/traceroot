import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type {
  AlertFilter,
  AlertSeverity,
  AlertThresholdOperator,
  AlertWindow,
} from "@traceroot/core";

export { createRedisConnection } from "./detector-run-queue.js";

export const ALERT_NOTIFICATION_QUEUE = "alert-notification";

/** Undoes what the scheduler committed. Epoch ms, not Date: the job round-trips through JSON. */
export interface AlertEmissionClaim {
  /** The boundary the emission evaluated, which is also the `alertedAt` it wrote. */
  evaluatedAt: number;
  priorSeverity: AlertSeverity;
  priorSeverityChangedAt: number | null;
  priorAlertedAt: number | null;
}

export interface AlertNotification {
  alertId: string;
  projectId: string;
  name: string;
  severity: AlertSeverity;
  previousSeverity: AlertSeverity;
  /** Null when the window produced no value (NO_DATA). */
  value: number | null;
  threshold: number;
  thresholdOperator: AlertThresholdOperator;
  measure: string;
  aggregation: string;
  window: AlertWindow;
  windowStart: Date;
  windowEnd: Date;
  // Optional: jobs enqueued before this field existed render without their filters.
  filters?: readonly AlertFilter[];
  // Optional: jobs enqueued before this field existed are delivered but never compensated.
  emission?: AlertEmissionClaim;
}

/** The same notification as it survives Redis: JSON carries no Date. */
export interface AlertNotificationJob extends Omit<AlertNotification, "windowStart" | "windowEnd"> {
  windowStart: number;
  windowEnd: number;
}

/**
 * Twelve attempts on a capped exponential is about 30 minutes: long enough to ride out an
 * outage, capped per gap so a recovered Slack is not waited on. Exhausting it reverts the rule.
 */
export const ALERT_NOTIFICATION_ATTEMPTS = 12;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 300_000;

export function alertNotificationBackoff(attemptsMade: number): number {
  const doublings = Math.max(0, attemptsMade - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** doublings, BACKOFF_CAP_MS);
}

/** Permanent failures are handled in the processor; these attempts are for transient ones. */
export const ALERT_NOTIFICATION_JOB_OPTIONS: JobsOptions = {
  attempts: ALERT_NOTIFICATION_ATTEMPTS,
  backoff: { type: "alert-capped" },
  removeOnComplete: { age: 6 * 3600 },
  removeOnFail: 100,
};

export function createAlertNotificationQueue(connection: Redis): Queue<AlertNotificationJob> {
  return new Queue<AlertNotificationJob>(ALERT_NOTIFICATION_QUEUE, {
    connection,
    defaultJobOptions: ALERT_NOTIFICATION_JOB_OPTIONS,
  });
}
