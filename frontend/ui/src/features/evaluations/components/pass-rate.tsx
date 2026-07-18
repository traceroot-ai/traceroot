import { pctFraction } from "@/features/offline-eval/utils";
import { passRate, excludedSummary, type ResultStatusCounts } from "@/lib/eval/pass-rate";

/**
 * Share of judgeable cases that passed. Errored and not-scored cases are excluded
 * from both sides of the fraction and surfaced in the title instead.
 *
 * `withLabel` is the run-detail filter-bar form ("18/22 passed · 81.8%"); the bare
 * form is the runs-table cell (fraction over percentage).
 */
export function PassRate({
  counts,
  withLabel = false,
}: {
  counts: ResultStatusCounts;
  withLabel?: boolean;
}) {
  const rate = passRate(counts.passedCount, counts.failedCount);
  const title = excludedSummary(counts.erroredCount, counts.notScoredCount) ?? undefined;

  // No case was judged: an all-errored run is not a 0% run.
  if (rate === null) {
    return (
      <span className="text-muted-foreground" title={title}>
        —
      </span>
    );
  }

  const judged = counts.passedCount + counts.failedCount;
  const fraction = `${counts.passedCount}/${judged}`;

  if (withLabel) {
    return (
      <span className="text-[12px] tabular-nums text-muted-foreground" title={title}>
        <span className="text-foreground">{fraction} passed</span> · {pctFraction(rate)}
      </span>
    );
  }

  // A block wrapper, not a span: the two stacked lines are divs and a span may not
  // contain block-level children.
  return (
    <div title={title}>
      <div>{fraction}</div>
      <div className="text-[11px] text-muted-foreground">{pctFraction(rate)}</div>
    </div>
  );
}
