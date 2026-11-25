/**
 * How much of the selection every run covers, in words for the comparison page.
 */
import { MAX_RUN_DETAIL_RESULTS } from "@/lib/eval/run-detail-results";
import type { CompareModel, RunBundle } from "./model";

export const casesText = (n: number) => `${n} ${n === 1 ? "case" : "cases"}`;

/** Whether any case is in at least two of the runs, so there is something to compare. A
 *  case every run has isn't needed: one run with no results, or on an unrelated dataset,
 *  mustn't hide the pairs the other runs make. */
export function hasPairedCases(model: Pick<CompareModel, "cases">): boolean {
  return model.cases.some((c) => c.byRun.size >= 2);
}

/** "#3 has no results." or "#1 and #2 have no results." */
export function noResultsText(tags: readonly string[]): string {
  const runs = new Intl.ListFormat("en", { type: "conjunction" }).format(tags);
  return `${runs} ${tags.length === 1 ? "has" : "have"} no results.`;
}

/** "12 cases · 10 in all runs"; just "12 cases in all runs" when every run has every
 *  case. */
export function coverageSummary({
  total,
  sharedByAll,
}: {
  total: number;
  sharedByAll: number;
}): string {
  if (sharedByAll === total) return `${casesText(total)} in all runs`;
  return `${casesText(total)} · ${sharedByAll} in all runs`;
}

/** "1 matching · 12 total": how many cases a search or filters match, of all of them. */
export function matchingSummary({ matching, total }: { matching: number; total: number }): string {
  return `${matching} matching · ${total} total`;
}

/** Whether the page's result limit cut the run off before its last case. */
export function cutAtLimit({ run, results }: RunBundle): boolean {
  // The read flags a run that reported fewer cases alike; only one that filled the limit
  // was cut off by it.
  return (
    run.caseCount > results.length &&
    run.resultsTruncated &&
    results.length >= MAX_RUN_DETAIL_RESULTS
  );
}

/** One note per run whose results fall short of the cases it declared, each led by the
 *  run's tag and saying why: it has no results, the page stopped at its result limit, or
 *  the run itself reported fewer cases. */
export function partialRunNotes(
  runs: readonly RunBundle[],
  tagOf: (runId: string) => string,
): string[] {
  return runs.flatMap((bundle) => {
    const { run, results } = bundle;
    if (results.length === 0) return [noResultsText([tagOf(run.id)])];
    // Negated so a run read without a case count says nothing either.
    if (!(run.caseCount > results.length)) return [];
    // Pinned so the count reads "1,240" whatever the viewer's locale.
    const declared = run.caseCount.toLocaleString("en-US");
    const loaded = results.length.toLocaleString("en-US");
    return cutAtLimit(bundle)
      ? [`${tagOf(run.id)} has ${declared} cases; this page loaded the first ${loaded}.`]
      : [`${tagOf(run.id)} reported ${loaded} of ${declared} cases.`];
  });
}

/** The notes as one line: the note itself when one run falls short, else how many do (each
 *  run's note then goes in a tooltip). */
export function partialNotesLine(notes: readonly string[]): string | null {
  if (notes.length === 0) return null;
  if (notes.length === 1) return notes[0];
  return `${notes.length} runs are missing cases`;
}
