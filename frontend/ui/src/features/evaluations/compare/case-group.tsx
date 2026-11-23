"use client";

import * as React from "react";
import { TBody, Td } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ResultRow } from "../types";
import { CaseLine } from "./case-line";
import { GROUP_EDGE, INPUT_COLUMN, RunStack, TextValue } from "./cells";
import {
  expectedKeyOf,
  inputKeyOf,
  type CaseRow,
  type PairComparison,
  type RunBundle,
  type ScorerColumn,
} from "./model";

/**
 * One case across the compared runs, as a group of lines: one line per run (`CaseLine`),
 * the baseline's first, then the others in display order. Input and Expected span the
 * group, showing one value when every run that has the case agrees on it, else each run's
 * own, marked with its run. A line's scorer values are the scores the comparison read,
 * with the change it found against the baseline, so a value never contradicts the
 * summary's improved/regressed counts. Hovering any line highlights all of it.
 *
 * Memoized: a comparison can hold thousands of cases, and a keystroke in the search
 * should re-render only the groups it changes, so every prop is stable.
 */
export const CaseGroup = React.memo(function CaseGroup({
  row,
  ordered,
  baseline,
  pairs,
  dotFor,
  labelOf,
  tagOf,
  scorers,
}: {
  row: CaseRow;
  ordered: RunBundle[];
  baseline: RunBundle;
  /** Each candidate's comparison with the baseline, by candidate run id. */
  pairs: ReadonlyMap<string, PairComparison>;
  dotFor: (runId: string) => string;
  /** A run's tag and version, naming a line and each value of a split Input or Expected. */
  labelOf: (runId: string) => string;
  tagOf: (runId: string) => string;
  scorers: ScorerColumn[];
}) {
  const present = [...row.byRun.values()];

  // Collapse a per-run string column to one value when the runs that have the case agree
  // (`undefined` when they don't). `sameOn` decides agreement; the displayed value is
  // still the raw text.
  const collapsed = (get: (r: ResultRow) => string | null, sameOn: (r: ResultRow) => string) => {
    const keys = new Set(present.map(sameOn));
    return keys.size <= 1 ? get(present[0]) : undefined;
  };
  // Input collapses on the ALIGNING key, not the raw text: rows aligned across datasets
  // by `canonicalInputKey` (differing JSON key order, or legacy plaintext vs JSON-encoded)
  // are the "same input" and render once, while genuinely edited same-dataset inputs stay
  // split by run. The model already worked each result's key out while aligning. Expected
  // collapses on the text a value diff reads, so key order or spacing don't split it.
  const collapsedInput = collapsed((r) => r.input, inputKeyOf);
  const collapsedExpected = collapsed((r) => r.expectedOutput, expectedKeyOf);

  // Input or Expected when the runs differ on it: each run's own, marked with its run.
  const split = (get: (r: ResultRow) => string | null) => (
    <RunStack
      tooltipped
      values={ordered.flatMap((b) => {
        const r = row.byRun.get(b.run.id);
        if (!r) return [];
        return {
          runId: b.run.id,
          dot: dotFor(b.run.id),
          label: labelOf(b.run.id),
          node: <TextValue text={get(r)} />,
        };
      })}
    />
  );
  const spanning = (
    className: string,
    shared: string | null | undefined,
    get: (r: ResultRow) => string | null,
  ) => (
    <Td rowSpan={ordered.length} className={cn("align-top", className, GROUP_EDGE)}>
      {shared !== undefined ? <TextValue text={shared} /> : split(get)}
    </Td>
  );
  const input = spanning(INPUT_COLUMN, collapsedInput, (r) => r.input);
  const expected = spanning(
    "max-w-[240px] text-muted-foreground",
    collapsedExpected,
    (r) => r.expectedOutput,
  );

  return (
    <TBody className="hover:bg-muted">
      {ordered.map((b, i) => {
        const runId = b.run.id;
        return (
          <CaseLine
            key={runId}
            runId={runId}
            result={row.byRun.get(runId)}
            isBaseline={b === baseline}
            baselineResult={row.byRun.get(baseline.run.id)}
            pairCase={pairs.get(runId)?.byCase.get(row.key)}
            scorers={scorers}
            dot={dotFor(runId)}
            tag={tagOf(runId)}
            label={labelOf(runId)}
            first={i === 0}
            last={i === ordered.length - 1}
            input={i === 0 ? input : undefined}
            expected={i === 0 ? expected : undefined}
          />
        );
      })}
    </TBody>
  );
});
