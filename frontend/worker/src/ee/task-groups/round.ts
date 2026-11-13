import { DAILY_SAMPLE_TARGET, SUMMARY_COST_ESTIMATE_USD } from "@traceroot/core/task-groups";
import { buildJudgeInput } from "../../detection/judge-input.js";
import { EMBEDDING_MODEL } from "../signals/config.js";
import type { EmbeddingResult } from "../signals/embedding.js";
import { placeInGroup } from "./assign.js";
import type { TaskGroupBackend } from "./backend-client.js";
import {
  CANDIDATE_SLACK,
  DIGEST_CHUNK,
  DIGEST_VERSION,
  EMBEDDING_USD_PER_TOKEN,
  PLACE_CHUNK,
  ROUND_MAX_TRACES,
  SAMPLE_LOOKBACK_DAYS,
  SUMMARY_CONCURRENCY,
  SUMMARY_INPUT_BUDGET_CHARS,
  SUMMARY_MODEL_ID,
  TRACE_IDLE_MS,
} from "./config.js";
import { dayStartMs, pickSample, quotaAllowed } from "./sampler.js";
import type { Summarize } from "./summarize.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RoundSettings {
  enabled: boolean;
  dailyCostCapUsd: number;
}

export interface RoundDeps {
  backend: TaskGroupBackend;
  /** Null when the deployment has no key; the round then does nothing. */
  apiKeyConfigured: () => boolean;
  settings: (projectId: string) => Promise<RoundSettings>;
  /** Spend recorded for today, in US dollars. */
  spentToday: (projectId: string, nowMs: number) => Promise<number>;
  addSpend: (
    projectId: string,
    nowMs: number,
    spend: { summaries: number; costUsd: number },
  ) => Promise<void>;
  summarize: Summarize;
  embed: (texts: string[]) => Promise<EmbeddingResult>;
  /** Counts a trace's failure; returns true once it should be skipped for a while. */
  failures: {
    record: (projectId: string, traceId: string) => Promise<number>;
    isSkipped: (projectId: string, traceId: string) => Promise<boolean>;
  };
  now: () => number;
}

export type RoundSkip = "off" | "no-key" | "capped";

export interface RoundStats {
  skipped?: RoundSkip;
  /** Summaries written this round. */
  digested: number;
  /** Traces that could not be summarized (no task, no spans, model trouble). */
  failed: number;
  /** Traces placed in a group (or in none) this round. */
  placed: number;
  /** True when the trace limit was hit and more may be waiting. */
  more: boolean;
  spentUsd: number;
}

function empty(skipped?: RoundSkip): RoundStats {
  return { skipped, digested: 0, failed: 0, placed: 0, more: false, spentUsd: 0 };
}

/** Run `fn` over `items`, at most `limit` at a time, keeping result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * One round for a project: pick the traces the sampler allows, summarize and
 * embed them, store the rows, then place every stored summary that has no
 * placement under the current groups. Stops cleanly at the daily spend cap.
 * Nothing here calls a model to place a trace.
 */
export async function runDigestRound(deps: RoundDeps, projectId: string): Promise<RoundStats> {
  const settings = await deps.settings(projectId);
  if (!settings.enabled) return empty("off");
  if (!deps.apiKeyConfigured()) return empty("no-key");

  const stats = empty();
  const startMs = deps.now();
  let spent = await deps.spentToday(projectId, startMs);
  if (spent + SUMMARY_COST_ESTIMATE_USD > settings.dailyCostCapUsd) {
    stats.skipped = "capped";
    await place(deps, projectId, stats);
    return stats;
  }

  const today = dayStartMs(startMs);
  let budget = ROUND_MAX_TRACES;
  // Newest day first: current traces matter most.
  for (let back = 0; back < SAMPLE_LOOKBACK_DAYS && budget > 0; back++) {
    const dayStart = today - back * DAY_MS;
    const room = quotaAllowed(dayStart, startMs, DAILY_SAMPLE_TARGET);
    if (room <= 0) continue;
    const found = await deps.backend.candidates({
      projectId,
      sinceMs: dayStart,
      untilMs: dayStart + DAY_MS,
      idleBeforeMs: startMs - TRACE_IDLE_MS,
      limit: Math.min(5_000, room + CANDIDATE_SLACK),
    });
    const usable = [];
    for (const row of found.rows) {
      if (!(await deps.failures.isSkipped(projectId, row.traceId))) usable.push(row);
    }
    const picked = pickSample({
      projectId,
      candidates: usable,
      digested: found.digested,
      dayStart,
      nowMs: startMs,
    }).slice(0, budget);
    if (picked.length === 0) continue;

    for (let i = 0; i < picked.length; i += DIGEST_CHUNK) {
      // Only as many traces as the day's remaining budget pays for at the estimate.
      const affordable = Math.floor((settings.dailyCostCapUsd - spent) / SUMMARY_COST_ESTIMATE_USD);
      if (affordable <= 0) {
        stats.skipped = "capped";
        break;
      }
      const chunk = picked.slice(i, i + Math.min(DIGEST_CHUNK, affordable));
      if (chunk.length < Math.min(DIGEST_CHUNK, picked.length - i)) stats.skipped = "capped";
      const result = await summarizeChunk(deps, projectId, chunk);
      stats.digested += result.written;
      stats.failed += result.failed;
      stats.spentUsd += result.costUsd;
      spent += result.costUsd;
      budget -= chunk.length;
      if (stats.skipped === "capped") break;
      if (spent + SUMMARY_COST_ESTIMATE_USD > settings.dailyCostCapUsd) {
        stats.skipped = "capped";
        break;
      }
    }
    if (stats.skipped === "capped") break;
  }
  if (budget <= 0) stats.more = true;
  await place(deps, projectId, stats);
  return stats;
}

async function summarizeChunk(
  deps: RoundDeps,
  projectId: string,
  chunk: { traceId: string; traceTimeMs: number }[],
): Promise<{ written: number; failed: number; costUsd: number }> {
  let costUsd = 0;
  let failed = 0;
  const summarized = await mapLimit(chunk, SUMMARY_CONCURRENCY, async (trace) => {
    try {
      const jsonl = await deps.backend.spansJsonl(projectId, trace.traceId);
      const rendered = buildJudgeInput(trace.traceId, jsonl, {
        budgetChars: SUMMARY_INPUT_BUDGET_CHARS,
      });
      if (rendered.stats.span_count === 0) throw new Error("trace has no spans");
      const res = await deps.summarize(rendered.text);
      costUsd += res.costUsd;
      if (!res.summary) throw new Error("no discernible task");
      return { trace, summary: res.summary, summaryCost: res.costUsd };
    } catch {
      await deps.failures.record(projectId, trace.traceId);
      failed++;
      return null;
    }
  });
  const ok = summarized.filter((x): x is NonNullable<typeof x> => x !== null);
  if (ok.length === 0) {
    if (costUsd > 0) await deps.addSpend(projectId, deps.now(), { summaries: 0, costUsd });
    return { written: 0, failed, costUsd };
  }
  const embedding = await deps.embed(ok.map((x) => x.summary));
  const embedCost = embedding.inputTokens * EMBEDDING_USD_PER_TOKEN;
  costUsd += embedCost;
  await deps.backend.writeDigests(
    projectId,
    ok.map((x, i) => ({
      traceId: x.trace.traceId,
      traceTimeMs: x.trace.traceTimeMs,
      summary: x.summary,
      embedding: embedding.vectors[i],
      summaryModel: SUMMARY_MODEL_ID,
      embeddingModel: EMBEDDING_MODEL,
      digestVersion: DIGEST_VERSION,
      costUsd: x.summaryCost + embedCost / ok.length,
    })),
  );
  await deps.addSpend(projectId, deps.now(), { summaries: ok.length, costUsd });
  return { written: ok.length, failed, costUsd };
}

/** Place every stored summary that has no placement under the current fit. No model call. */
async function place(deps: RoundDeps, projectId: string, stats: RoundStats): Promise<void> {
  const { fitId, groups } = await deps.backend.currentGroups(projectId);
  if (!fitId) return;
  for (;;) {
    const rows = await deps.backend.unplaced(projectId, fitId, PLACE_CHUNK);
    if (rows.length === 0) return;
    const placements = rows.map((r) => ({ row: r, ...placeInGroup(r.embedding, groups) }));
    await deps.backend.writeMembers(
      projectId,
      fitId,
      "assigned",
      placements.map((p) => ({
        traceId: p.row.traceId,
        traceTimeMs: p.row.traceTimeMs,
        groupId: p.groupId,
        distance: p.distance,
      })),
    );
    stats.placed += rows.length;
    if (rows.length < PLACE_CHUNK) return;
  }
}
