"use client";

import * as React from "react";
import { ArrowDownWideNarrow } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DATASET_ORDER, sortsByRegression, type CaseSort } from "./filters";
import type { CompareModel } from "./model";

const DATASET = "dataset";

/**
 * The toolbar's Sort control: dataset order, or one candidate's largest regression on a
 * scorer first. A scorer with no direction has no regression, so it's listed but off.
 */
export function SortSelect({
  model,
  sort,
  tagOf,
  disabled = false,
  onChange,
}: {
  model: CompareModel;
  sort: CaseSort;
  tagOf: (runId: string) => string;
  disabled?: boolean;
  onChange: (sort: CaseSort) => void;
}) {
  const candidates = model.runs.filter(({ run }) => run.id !== model.baselineRunId);
  const sorts = model.scorers.filter(sortsByRegression).flatMap((column) =>
    candidates.map(({ run }) => ({
      sort: { kind: "regression", scorer: column.name, runId: run.id } as const,
      label: `Largest regression · ${column.name} · ${tagOf(run.id)}`,
      // The toolbar shows this, so it stays on one row; the list and the name say it in full.
      short: `↘ ${column.name} · ${tagOf(run.id)}`,
    })),
  );
  // Options go by index, so a scorer's name never has to fit in a value. A sort that
  // names nothing compared reads as dataset order, which is how the table sorts it.
  const current = sorts.findIndex(
    ({ sort: s }) =>
      sort.kind === "regression" && s.scorer === sort.scorer && s.runId === sort.runId,
  );

  const selected = current < 0 ? null : sorts[current];

  return (
    <Select
      disabled={disabled}
      value={current < 0 ? DATASET : String(current)}
      onValueChange={(value) =>
        onChange(value === DATASET ? DATASET_ORDER : sorts[Number(value)].sort)
      }
    >
      <SelectTrigger
        aria-label={`Sort cases: ${selected?.label ?? "Dataset order"}`}
        className="h-8 w-auto max-w-[220px] gap-1.5 text-[12px]"
      >
        <ArrowDownWideNarrow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <SelectValue>{selected?.short ?? "Dataset order"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DATASET}>Dataset order</SelectItem>
        {sorts.map(({ label }, i) => (
          <SelectItem key={i} value={String(i)}>
            {label}
          </SelectItem>
        ))}
        {model.scorers
          .filter((column) => !sortsByRegression(column))
          .map((column) => (
            <SelectItem key={column.name} value={`off:${column.name}`} disabled>
              {`Largest regression · ${column.name} (no direction)`}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
