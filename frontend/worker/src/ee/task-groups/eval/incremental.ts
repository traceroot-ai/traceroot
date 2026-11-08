/**
 * The baseline the periodic fit is compared with: assign each summary, in time order, to
 * an existing group or start a new one, deciding with a model over the few nearest groups
 * (a shortlist by cosine similarity of one example embedding per group, then a model that
 * picks one or says "none"). No fit, no refit: a group, once made, never changes.
 *
 * Evaluation code only; nothing in the product runs it.
 */

import { cosine } from "../../signals/shortlist.js";

export interface Item {
  traceId: string;
  traceTimeMs: number;
  summary: string;
  embedding: number[];
}

export interface BaselineGroup {
  id: string;
  title: string;
  /** What belongs here, in the model's words. */
  covers: string;
  /** The summary and embedding of the trace that started the group. */
  exampleSummary: string;
  exampleEmbedding: readonly number[];
  size: number;
}

/** What the judge sees of a group. */
export interface Candidate {
  /** A short label ("A", "B", ...) the judge answers with. */
  label: string;
  title: string;
  covers: string;
  example: string;
}

export interface Judge {
  /** The candidate's label, or "none". One model call. */
  choose(summary: string, candidates: readonly Candidate[]): Promise<string>;
  /** A title and a description for a new group. One model call. */
  describe(
    summary: string,
    candidates: readonly Candidate[],
  ): Promise<{ title: string; covers: string }>;
}

export interface BaselineResult {
  /** Trace id to group id, in the order processed. */
  assignments: Record<string, string>;
  groups: BaselineGroup[];
  chooseCalls: number;
  describeCalls: number;
}

/** Candidates offered to the judge per summary. */
export const SHORTLIST_K = 10;

function labelFor(i: number): string {
  let n = i;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** The k groups whose example is nearest the vector, nearest first; ties keep creation order. */
export function nearestGroups(
  vector: readonly number[],
  groups: readonly BaselineGroup[],
  k: number,
): BaselineGroup[] {
  return groups
    .map((g, i) => ({ g, i, sim: cosine(vector, g.exampleEmbedding) }))
    .sort((a, b) => b.sim - a.sim || a.i - b.i)
    .slice(0, k)
    .map((x) => x.g);
}

export async function assignIncrementally(
  items: readonly Item[],
  judge: Judge,
  k: number = SHORTLIST_K,
): Promise<BaselineResult> {
  const groups: BaselineGroup[] = [];
  const assignments: Record<string, string> = {};
  let chooseCalls = 0;
  let describeCalls = 0;
  for (const item of items) {
    const near = nearestGroups(item.embedding, groups, k);
    const candidates: Candidate[] = near.map((g, i) => ({
      label: labelFor(i),
      title: g.title,
      covers: g.covers,
      example: g.exampleSummary,
    }));
    let chosen: BaselineGroup | undefined;
    if (candidates.length > 0) {
      chooseCalls++;
      const answer = (await judge.choose(item.summary, candidates)).trim();
      const index = candidates.findIndex((c) => c.label === answer);
      if (index >= 0) chosen = near[index];
    }
    if (!chosen) {
      describeCalls++;
      const text = await judge.describe(item.summary, candidates);
      chosen = {
        id: `b_${groups.length + 1}`,
        title: text.title,
        covers: text.covers,
        exampleSummary: item.summary,
        exampleEmbedding: item.embedding,
        size: 0,
      };
      groups.push(chosen);
    }
    chosen.size++;
    assignments[item.traceId] = chosen.id;
  }
  return { assignments, groups, chooseCalls, describeCalls };
}
