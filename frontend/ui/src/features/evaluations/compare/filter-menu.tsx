"use client";

import * as React from "react";
import { ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FILTER_KINDS, FILTER_LABEL, type CaseFilter, type FilterKind } from "./filters";
import type { CompareModel } from "./model";

const ANY = "any";

const HINT: Record<FilterKind, string> = {
  regressed: "worse than the baseline",
  improved: "better than the baseline",
  changed: "different from the baseline",
  errors: "a task or scorer error",
  unmatched: "missing from a run",
};

/**
 * The toolbar's Filters menu: pick a metric and a run (any of them, unless picked), then
 * which cases to show. Improved and regressed need a metric with a direction, and only a
 * candidate changes against the baseline, so the kinds that can't pick anything are off
 * and say why.
 */
export function FilterMenu({
  model,
  tagOf,
  disabled = false,
  triggerRef,
  onAdd,
}: {
  model: CompareModel;
  tagOf: (runId: string) => string;
  disabled?: boolean;
  /** The Filters button, for the toolbar to put focus back on. */
  triggerRef?: React.Ref<HTMLButtonElement>;
  onAdd: (filter: CaseFilter) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [pickedScorer, setScorer] = React.useState<string | null>(null);
  const [pickedRun, setRunId] = React.useState(ANY);
  // A pick the comparison no longer has (a run since removed) falls back to any.
  const column = model.scorers.find((s) => s.name === pickedScorer);
  const scorer = column?.name ?? null;
  const runId = model.runs.some(({ run }) => run.id === pickedRun) ? pickedRun : ANY;

  const directionless =
    !!column && (column.valueType === "categorical" || column.direction === "none");
  const onBaseline = runId === model.baselineRunId;
  /** Why a kind can't pick anything with this metric and run, shown in place of its hint. */
  const unavailable = (kind: FilterKind): string | null => {
    if (kind === "errors" || kind === "unmatched") return null;
    if (onBaseline) return "pick a run other than the baseline";
    return kind !== "changed" && directionless ? "metric has no direction" : null;
  };

  const add = (kind: FilterKind) => {
    onAdd({ kind, scorer: kind === "unmatched" ? null : scorer, runId });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-8 gap-1 text-[12px]"
        >
          <ListFilter className="h-3.5 w-3.5" aria-hidden />
          Filters
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Filters" className="w-[300px] p-0 text-[12px]">
        <div className="grid grid-cols-[3.5rem_1fr] items-center gap-2 border-b border-border p-2">
          <span className="text-muted-foreground">Metric</span>
          {/* Metrics go by index, so one named "any" is never taken for Any metric. */}
          <Select
            value={column ? String(model.scorers.indexOf(column)) : ANY}
            onValueChange={(value) =>
              setScorer(value === ANY ? null : model.scorers[Number(value)].name)
            }
          >
            <SelectTrigger aria-label="Metric" className="h-7 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any metric</SelectItem>
              {model.scorers.map((s, i) => (
                <SelectItem key={s.name} value={String(i)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">Run</span>
          <Select value={runId} onValueChange={setRunId}>
            <SelectTrigger aria-label="Run" className="h-7 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any run</SelectItem>
              {model.runs.map(({ run }) => (
                <SelectItem key={run.id} value={run.id}>
                  {`${tagOf(run.id)} ${run.candidateVersion}`}
                  {run.id === model.baselineRunId && " · baseline"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="p-1">
          <p className="px-2 pb-0.5 pt-1 text-muted-foreground">Show cases</p>
          {FILTER_KINDS.map((kind) => {
            const why = unavailable(kind);
            return (
              <button
                key={kind}
                type="button"
                disabled={why !== null}
                onClick={() => add(kind)}
                className="flex w-full items-baseline gap-2 rounded-[2px] px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="font-medium">{FILTER_LABEL[kind]}</span>{" "}
                <span className="text-muted-foreground">{why ?? HINT[kind]}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
