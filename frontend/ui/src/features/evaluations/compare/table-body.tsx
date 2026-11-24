"use client";

import * as React from "react";
import { TBody } from "@/components/ui/table";
import { EmptyState } from "@/features/offline-eval/components";
import { CaseGroup } from "./case-group";
import type { CaseRow, CompareModel, PairComparison, RunBundle } from "./model";

/**
 * The comparison table's body: one group of lines per case the search picks, in their
 * order; or, when it picks none, one row across the columns that says so.
 */
export function ComparisonBody({
  model,
  baseline,
  rows,
  pairs,
  dotFor,
  labelOf,
  tagOf,
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
}) {
  if (rows.length === 0) {
    return (
      <TBody>
        <tr>
          {/* Input, Run, Output and Expected, each scorer, then latency and cost. */}
          <td colSpan={model.scorers.length + 6}>
            <EmptyState>No rows match your search.</EmptyState>
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
        />
      ))}
    </>
  );
}
