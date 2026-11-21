/**
 * Loop scheduler settings, read from the environment on every call so a test
 * (or a tick) sees the current value. LOOPS_ENABLED stays the UI switch; the
 * worker only runs Loops when LOOP_SCHEDULER_ENABLED is set.
 */
import { LOOP_LIMITS } from "@traceroot/core/loops";
import { isTruthyEnvValue } from "../scheduling/env-flag.js";

/** Off unless "true", "1", "yes" or "on". */
export function isLoopSchedulerEnabled(
  value: string | undefined = process.env.LOOP_SCHEDULER_ENABLED,
): boolean {
  return isTruthyEnvValue(value);
}

export const DEFAULT_LOOP_TICK_CRON = "*/5 * * * *";
export const DEFAULT_LOOP_RUN_CONCURRENCY = 2;

/** A run still "running" this long past its timeout belongs to a dead worker. */
export const LOOP_RECLAIM_GRACE_MS = 5 * 60_000;
/** A reclaimed run is retried until it has been tried this many times, then failed. */
export const LOOP_RUN_MAX_ATTEMPTS = 2;
/** The agent call is aborted this long after the run's deadline. */
export const LOOP_AGENT_ABORT_SLACK_MS = 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number((value ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loopTickCron(): string {
  return process.env.LOOP_TICK_CRON?.trim() || DEFAULT_LOOP_TICK_CRON;
}

export function loopRunTimeoutMs(): number {
  return positiveInt(process.env.LOOP_RUN_TIMEOUT_MS, LOOP_LIMITS.runTimeoutMinutes * 60_000);
}

export function loopRunConcurrency(): number {
  return positiveInt(process.env.LOOP_RUN_CONCURRENCY, DEFAULT_LOOP_RUN_CONCURRENCY);
}
