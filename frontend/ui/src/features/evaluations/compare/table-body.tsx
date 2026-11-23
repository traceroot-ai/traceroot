"use client";

import * as React from "react";
import { TBody } from "@/components/ui/table";
import { CaseGroup } from "./case-group";
import { shownColumnCount, type DisplayPrefs } from "./display";
import { NoMatchingCases } from "./empty-states";
import type { CaseInspectorState } from "./inspector/use-case-inspector";
import type { CaseRow, CompareModel, PairComparison, RunBundle } from "./model";

/**
 * The comparison table's body: one group of lines per case the search and filters pick, in
 * their order, each opening in the trace panel; or, when they pick none, one row across the
 * columns shown that says so and clears them.
 */
export function ComparisonBody({
  model,
  baseline,
  rows,
  pairs,
  dotFor,
  labelOf,
  tagOf,
  display,
  rowProps,
  clearLabel,
  onClear,
}: {
  model: CompareModel;
  baseline: RunBundle;
  /** The cases to show, in order. */
  rows: readonly CaseRow[];
  /** Each candidate's comparison with the baseline, by candidate run id. */
  pairs: ReadonlyMap<string, PairComparison>;
  dotFor: (runId: string) => string;
  labelOf: (runId: string) => string;
  tagOf: (runId: string) => string;
  display: DisplayPrefs;
  /** Each case's way of opening in the trace panel. */
  rowProps: CaseInspectorState["rowProps"];
  /** What the empty row's button takes off (`clearLabel`). */
  clearLabel: string;
  onClear: () => void;
}) {
  if (rows.length === 0) {
    return (
      <TBody>
        <tr>
          <td colSpan={shownColumnCount(display, model.scorers)}>
            <NoMatchingCases label={clearLabel} onClear={onClear} />
          </td>
        </tr>
      </TBody>
    );
  }
  return (
    <>
      {rows.map((row) => (
        <CaseGroup
          key={row.key}
          row={row}
          ordered={model.runs}
          baseline={baseline}
          pairs={pairs}
          dotFor={dotFor}
          labelOf={labelOf}
          tagOf={tagOf}
          scorers={model.scorers}
          display={display}
          {...rowProps(row)}
        />
      ))}
    </>
  );
}
