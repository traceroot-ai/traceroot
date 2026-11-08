/**
 * Task-group contract shared by the worker (sampling, summaries, placement) and
 * the UI routes. The words users see come from this file only.
 */

/** The feature's name in the UI. A working name; change it here and nowhere else. */
export const TASK_GROUPS_LABEL = "Topics";
/** The same name for one group, in a column header or a filter chip. */
export const TASK_GROUP_LABEL = "Topic";

/** The one question asked of each trace today; a column in every task-group table. */
export const TASK_LENS = "task";

/** Traces summarized per project per UTC day, at most. */
export const DAILY_SAMPLE_TARGET = 300;

/** Fewer digested traces than this and no groups are fitted or shown. */
export const MIN_DIGESTS_FOR_GROUPS = 100;

/** Default spend cap per project per UTC day, in US dollars. */
export const DEFAULT_DAILY_COST_CAP_USD = 1;

/**
 * What one summary is assumed to cost before its real cost is known (measured:
 * about a quarter of this on the default model). The pipeline stops, and the
 * status reads "capped", when the day's remaining budget cannot pay for one.
 */
export const SUMMARY_COST_ESTIMATE_USD = 0.0005;

export const TASK_GROUP_QUEUE = "task-group-digest";

/** Why the pipeline is, or is not, running for a project. */
export const TASK_GROUP_STATUSES = ["off", "no_key", "capped", "collecting", "active"] as const;
export type TaskGroupStatus = (typeof TASK_GROUP_STATUSES)[number];
