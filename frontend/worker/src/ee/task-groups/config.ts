/**
 * Settings for the task-group pipeline: sampling, the summary prompt's version
 * and model, and the pacing of the worker. The user-facing numbers (daily target,
 * minimum volume, default cap) live in @traceroot/core/task-groups.
 */

import { ASSIGN_CHAT_MODEL_ID } from "../signals/config.js";

/** Chat model that writes the one-sentence task summary. */
export const SUMMARY_MODEL_ID = ASSIGN_CHAT_MODEL_ID;

/** Bumped whenever the summary prompt changes, so old rows stay identifiable. */
export const DIGEST_VERSION = 1;

/** Characters of rendered trace text the summary model reads. */
export const SUMMARY_INPUT_BUDGET_CHARS = 24_000;

/**
 * What the summary model charges, US dollars per token (the list price in
 * standard-model-prices.json). Used when the provider response carries no cost.
 */
export const SUMMARY_INPUT_USD_PER_TOKEN = 0.0000002;
export const SUMMARY_OUTPUT_USD_PER_TOKEN = 0.0000012;

/** A summary longer than this is cut; the prompt asks for far less. */
export const SUMMARY_MAX_CHARS = 400;

/** A trace is summarized only once nothing has been written to it for this long. */
export const TRACE_IDLE_MS = Number(process.env.TASK_GROUP_TRACE_IDLE_MS ?? 5 * 60_000);

/** How many UTC days back, today included, the sampler looks for traces. */
export const SAMPLE_LOOKBACK_DAYS = 7;

/** The day's quota opens up in this many equal slices, so one burst cannot use it all. */
export const QUOTA_SLICES_PER_DAY = 24;

/** Traces summarized per round before the job yields. */
export const ROUND_MAX_TRACES = 100;

/** Summaries embedded and written per call. */
export const DIGEST_CHUNK = 20;

/** Traces summarized at once inside a round. */
export const SUMMARY_CONCURRENCY = 4;

/** Extra candidates read beyond the quota, to step past traces that cannot be summarized. */
export const CANDIDATE_SLACK = 50;

/** A trace that fails this many times is skipped for SKIP_TTL_MS. */
export const SKIP_AFTER_FAILURES = 3;
export const SKIP_TTL_MS = 24 * 60 * 60 * 1000;

/** The scheduler enqueues a round for every enabled project this often. */
export const TICK_EVERY_MS = 5 * 60_000;

/** Placements read and written per call. */
export const PLACE_CHUNK = 200;

export const SUMMARY_TIMEOUT_MS = 60_000;
export const BACKEND_TIMEOUT_MS = 30_000;

/** text-embedding-3-small list price, US dollars per input token. */
export const EMBEDDING_USD_PER_TOKEN = 0.02 / 1_000_000;
