import { createHash } from "node:crypto";
import { DAILY_SAMPLE_TARGET } from "@traceroot/core/task-groups";
import { QUOTA_SLICES_PER_DAY } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A trace's place in the sampling order: the first eight bytes of
 * sha256("<project>:<trace>") as a big-endian unsigned integer. It depends on
 * nothing but the two ids, so a trace sorts the same way whenever it is looked at.
 * The backend computes the same number in SQL; a test pins the two together.
 */
export function sampleKey(projectId: string, traceId: string): bigint {
  return createHash("sha256").update(`${projectId}:${traceId}`).digest().readBigUInt64BE(0);
}

/** Order traces for sampling: lowest key first, trace id breaking a tie. */
export function bySampleKey<T extends { traceId: string }>(projectId: string, items: T[]): T[] {
  return items
    .map((item) => ({ item, key: sampleKey(projectId, item.traceId) }))
    .sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : a.item.traceId < b.item.traceId ? -1 : 1,
    )
    .map((x) => x.item);
}

export function dayStartMs(atMs: number): number {
  return Math.floor(atMs / DAY_MS) * DAY_MS;
}

/**
 * How many summaries a UTC day may hold at `nowMs`. A past day may hold the whole
 * target. The current day's target opens in equal slices, so a quiet morning's
 * unused quota carries forward (a small project is sampled fully) while a burst
 * early in the day cannot take it all.
 */
export function quotaAllowed(
  dayStart: number,
  nowMs: number,
  target: number = DAILY_SAMPLE_TARGET,
): number {
  if (nowMs >= dayStart + DAY_MS) return target;
  if (nowMs < dayStart) return 0;
  const slice = Math.min(
    QUOTA_SLICES_PER_DAY,
    Math.floor(((nowMs - dayStart) / DAY_MS) * QUOTA_SLICES_PER_DAY) + 1,
  );
  return Math.ceil((target * slice) / QUOTA_SLICES_PER_DAY);
}

export interface Candidate {
  traceId: string;
  traceTimeMs: number;
}

/**
 * The traces to summarize now for one UTC day: the lowest-key undigested
 * candidates, as many as the day's quota has room for. Pure: the same candidates,
 * count and clock give the same pick.
 *
 * @param candidates Finished traces of the day with no summary yet.
 * @param digested Summaries the day already holds.
 */
export function pickSample<T extends Candidate>(params: {
  projectId: string;
  candidates: T[];
  digested: number;
  dayStart: number;
  nowMs: number;
  target?: number;
}): T[] {
  const room = quotaAllowed(params.dayStart, params.nowMs, params.target) - params.digested;
  if (room <= 0) return [];
  return bySampleKey(params.projectId, params.candidates).slice(0, room);
}
