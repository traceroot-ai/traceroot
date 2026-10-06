/**
 * Settings for signal assignment. The shortlist size and the Jev acceptance
 * threshold come from the synthetic-corpus benchmark and are re-checked by the
 * corpus validation run before rollout.
 */

/** Embedding model for the shortlist; 1536-dimensional. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Chat model that assigns hits (when no Jev key is configured, or when Jev is
 * unsure), writes a new signal's title and criteria, and checks them. It is the
 * model the benchmark validated, called with the deployment's OpenAI key, so
 * one key serves both the embedding and the chat calls.
 */
export const ASSIGN_CHAT_MODEL_ID = "gpt-5.6-luna";

/** Signals offered to the assignment model per hit (nearest anchors by cosine). */
export const SHORTLIST_SIZE = 10;

/** Jev's answer stands at or above this probability; below it the chat model re-judges. */
export const JEV_ACCEPT_PROBABILITY = 0.9;

/** Delay before a partition's job runs, so a burst of hits is assigned in one job. */
export const ASSIGN_DELAY_MS = 30_000;

/** A round stops after this many hits or this long; the job then yields and continues. */
export const ROUND_MAX_HITS = 200;
export const ROUND_MAX_MS = 60_000;

/**
 * Hits embedded per embedding call. A round stops at ROUND_MAX_MS, which is
 * about 25 hits when the chat model decides each one; embedding the whole
 * round up front would pay again for every hit the next round picks up.
 */
export const EMBED_CHUNK = 25;

/**
 * BullMQ job lock. It must outlive a round plus one slow model call; BullMQ
 * renews it while the job runs, and a stalled job that is re-run is still
 * correct because every write is keyed by run_id under the partition lock.
 */
export const ASSIGN_LOCK_DURATION_MS = 180_000;

/** Partitions assigned in parallel by one worker process. */
export const ASSIGN_CONCURRENCY = 4;

/**
 * The sweeper runs this often and re-enqueues partitions marked pending more
 * than the stale age ago that no job has drained since (queue.ts keeps the mark
 * on the detector row, so a sweep is one read of the detectors table), at
 * most SWEEP_BATCH of them per run.
 */
export const SWEEP_EVERY_MS = 60_000;
export const SWEEP_STALE_MS = 120_000;
export const SWEEP_BATCH = 500;

/**
 * A drain clears pending marks written up to this long before its empty read,
 * allowing for clock skew between worker processes and for a just-written hit
 * not yet visible to the read.
 */
export const DRAIN_MARGIN_MS = 10_000;

/**
 * How far back the job looks for waiting hits, and how long a hit's failure
 * count is kept. It bounds the ClickHouse scan; a hit left unassigned for longer
 * (an outage of more than a week) is no longer read.
 */
export const WAITING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A hit whose model answers stay unusable (UnusableAnswerError) is given up
 * after at least this many of them spread over at least this long, so one bad
 * hit stops being retried. Other failures (a provider, key, network or
 * database outage) never count: the hit waits for the outage to end.
 */
export const GIVE_UP_AFTER_FAILURES = 3;
export const GIVE_UP_AFTER_MS = 6 * 60 * 60 * 1000;

/** Failures in a row that end a round: more likely an outage than bad hits. */
export const MAX_CONSECUTIVE_FAILURES = 2;

/** Rows sent to ClickHouse per write while a round runs. */
export const ASSIGNMENT_FLUSH_ROWS = 25;

/** Per-call budgets for the model calls. */
export const EMBEDDING_TIMEOUT_MS = 30_000;
export const CHAT_TIMEOUT_MS = 45_000;
export const JEV_TIMEOUT_MS = 20_000;
export const BACKEND_TIMEOUT_MS = 30_000;

/**
 * The OpenAI key signals run on. Without it the feature is off for every
 * detector: no grouping and no RCA, as if each detector's switch were off.
 */
export function signalsApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? key : null;
}

export function signalsAvailable(): boolean {
  return signalsApiKey() !== null;
}

/**
 * TraceRoot's own TypeSafe key. When set, Jev assigns hits and checks new
 * criteria for every workspace, on our account; without it the chat model does
 * both. A workspace's own TypeSafe key is not used for signals.
 */
export function managedJevKey(): string | null {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? key : null;
}

/**
 * A reopened signal gets a new RCA only if its last one that succeeded or is
 * still waiting or running is at least this old; a failed one does not count.
 */
export const RCA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * How long a signal RCA job waits before it runs again: after a run, when an
 * opening landed during it, or when an empty finding's opening may still be
 * committing. A trace's first run needs no delay: it starts once every hit of
 * the trace is settled (startSettledRcas).
 */
export const RCA_DELAY_MS = 60_000;

/** A signal RCA still pending after this long lost its job; the sweeper re-enqueues it. */
export const RCA_STALE_MS = 10 * 60 * 1000;
