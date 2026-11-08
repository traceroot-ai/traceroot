import type { TaskGroupStatus } from "@traceroot/core/task-groups";

/** One day of a group's trend: the sampled traces of that UTC day placed in the group. */
export interface TaskGroupTrendPoint {
  day: string;
  count: number;
}

export interface TaskGroupRow {
  groupId: string;
  name: string;
  description: string;
  /** Sampled traces in the range that are in this group. */
  count: number;
  /** count / sampled, 0..1. An estimate of the group's share of all traces. */
  share: number;
  trend: TaskGroupTrendPoint[];
}

export interface TaskGroupsState {
  enabled: boolean;
  status: TaskGroupStatus;
  dailyCostCapUsd: number;
  spentTodayUsd: number;
  summariesToday: number;
  /** Whether the deployment has the model key the pipeline needs. */
  keyConfigured: boolean;
}

export interface TaskGroupsOverview {
  state: TaskGroupsState;
  /** Summaries a project needs in the fit window before groups exist. */
  minDigests: number;
  /** Summaries in the fit window so far. */
  digestsInWindow: number;
  /** Sampled traces in the range, and how many of them are in no group. */
  sampled: number;
  ungrouped: number;
  fittedAt: string | null;
  groups: TaskGroupRow[];
  /** Days of the range, oldest first, for the trend axis. */
  days: string[];
  /** When "Refresh now" will be taken again; null when it can be used. */
  refreshAvailableAt: string | null;
}

export interface TraceTaskGroup {
  groupId: string;
  name: string;
}
