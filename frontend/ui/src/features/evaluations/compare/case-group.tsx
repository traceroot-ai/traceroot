"use client";

import * as React from "react";
import { TBody, Td } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ResultRow } from "../types";
import { CaseLine } from "./case-line";
import { GROUP_EDGE, INPUT_COLUMN, PINNED_FILL, RunStack, TextValue } from "./cells";
import {
  expectedKeyOf,
  inputKeyOf,
  type CaseRow,
  type PairComparison,
  type RunBundle,
  type ScorerColumn,
} from "./model";
import { clickOpensRow } from "./row-activation";

/**
 * One case across the compared runs, as a group of lines: one line per run (`CaseLine`),
 * the baseline's first, then the others in display order. Input and Expected span the
 * group, showing one value when every run that has the case agrees on it, else each run's
 * own, marked with its run. A line's scorer values are the scores the comparison read,
 * with the change it found against the baseline, so a value never contradicts the
 * summary's improved/regressed counts.
 *
 * The group is one target. Hovering any line highlights all of it. A click anywhere but
 * on a control opens the case in the trace panel on the run of the line clicked (the
 * baseline's line opens the default pair). The first line is the group's one tab stop and
 * opens it with Enter or Space; it stays a table row (no button role, which would flatten
 * its cells into one label for a screen reader), and `describedBy` tells how to open it.
 *
 * Memoized: a comparison can hold thousands of cases, and a keystroke in the search or a
 * case opening should re-render only the groups it changes, so every prop is stable.
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
  open,
  onOpenRow,
  describedBy,
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
  /** Whether the case is the one open in the trace panel. */
  open: boolean;
  /** Open a case; `runId` is the run of the line or value clicked, if any. One handler
   *  for every group. */
  onOpenRow: (row: CaseRow, runId: string | null) => void;
  /** Id of the text telling how to open a case. */
  describedBy?: string;
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
  // Input names the case, so it stays in view while the table scrolls sideways.
  const input = spanning(
    cn("col-sticky-start", INPUT_COLUMN, PINNED_FILL),
    collapsedInput,
    (r) => r.input,
  );
  const expected = spanning(
    "max-w-[240px] text-muted-foreground",
    collapsedExpected,
    (r) => r.expectedOutput,
  );

  const onClick = (e: React.MouseEvent<HTMLTableSectionElement>) => {
    const target = e.target as Element;
    if (!clickOpensRow(target, e.currentTarget)) return;
    // Selecting text to copy it is not a request to open the case.
    if (window.getSelection()?.toString()) return;
    onOpenRow(row, target.closest("[data-run-id]")?.getAttribute("data-run-id") ?? null);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
    // Only the group's own tab stop, not a control inside it.
    if (e.target !== e.currentTarget.firstElementChild) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onOpenRow(row, null);
  };

  return (
    <TBody
      data-selected={open ? "true" : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        // `group/row`: pinned cells take the group's fill.
        "group/row cursor-pointer",
        open ? "bg-accent" : "hover:bg-muted has-[>tr:focus-visible]:bg-muted",
      )}
    >
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
            tabStop={i === 0 ? { order: row.order, open, describedBy } : undefined}
          />
        );
      })}
    </TBody>
  );
});
