"use client";

import * as React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Table } from "@/components/ui/table";
import { EmptyState } from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useEvaluationRunDetails } from "../hooks";
import { COMPARISON_TABLE } from "../compare/cells";
import { hasPairedCases, noResultsText } from "../compare/coverage";
import { buildCompareModel, comparePairs, type RunBundle } from "../compare/model";
import { useRunDots } from "../compare/run-colors";
import { newestRun } from "../compare/run-order";
import { RunsMenu, type RunsMenuView } from "../compare/runs-menu";
import { runLabeler, runTagger } from "../compare/run-tags";
import { ScopeLine } from "../compare/scope-line";
import { ComparisonBody } from "../compare/table-body";
import { SummaryGroup } from "../compare/summary-group";
import { ComparisonHead } from "../compare/table-head";
import { CaseToolbar } from "../compare/toolbar";

// A run comparison is N runs (2+) lined up case-by-case, anchored on the baseline run
// (alignment lives in `../compare/model`). Each case is a group of lines, one per run,
// the baseline's first; against it every other run's line also shows a green/red
// improvement/regression change. The "All cases" group leads the body and compares each
// other run with the baseline on the cases both of them scored.

export function CompareRunsView({
  projectId,
  runIds,
  baselineId,
  onChangeBaseline,
  onChangeRuns,
}: {
  projectId: string;
  runIds: string[];
  baselineId: string | null;
  onChangeBaseline: (baselineId: string | null) => void;
  /** The runs to compare, in the order they were selected, and the baseline to keep: the
   *  one being compared against, or null when it was removed. */
  onChangeRuns: (runIds: string[], baselineId: string | null) => void;
}) {
  const queries = useEvaluationRunDetails(projectId, runIds);
  const [keyword, setKeyword] = React.useState("");
  // The Runs menu opens from its button.
  const [runsMenu, setRunsMenu] = React.useState<RunsMenuView | null>(null);

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.some((q) => q.isError);

  // Per-run colour by selection order (not display order), kept while the run is selected.
  const dotFor = useRunDots(runIds);

  const loaded = React.useMemo<RunBundle[]>(
    () => queries.map((q) => q.data).filter((d): d is NonNullable<typeof d> => !!d),
    [queries],
  );

  // The URL's baseline, or the oldest run when it names none of these runs; runs in
  // display order (baseline first); and the union of aligned cases.
  const model = React.useMemo(() => buildCompareModel(loaded, baselineId), [loaded, baselineId]);
  const ordered = model.runs;
  const baseline = ordered[0];
  const crossDataset = model.alignment === "canonical_input";
  const datasetNames = [...new Set(ordered.map((b) => b.run.datasetName ?? "—"))];

  // Each candidate against the baseline, on the cases both of them have.
  const pairs = React.useMemo(() => comparePairs(model), [model]);

  // Rows = every case any run has, in baseline order, that the search picks: any run's
  // input / output / expected for the case.
  const visible = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return model.cases;
    return model.cases.filter((c) =>
      [...c.byRun.values()].some(
        (r) =>
          r.input.toLowerCase().includes(q) ||
          (r.candidateOutput ?? "").toLowerCase().includes(q) ||
          (r.expectedOutput ?? "").toLowerCase().includes(q),
      ),
    );
  }, [model, keyword]);

  // Stable while the runs are, so the memoized case groups don't re-render on every
  // keystroke.
  const tagOf = React.useMemo(() => runTagger(ordered), [ordered]);
  const labelOf = React.useMemo(() => runLabeler(ordered, tagOf), [ordered, tagOf]);
  // Runs with no results; with fewer than two runs left, that is why nothing is compared.
  // Runs to add are suggested from before the newest one compared.
  const newest = newestRun(ordered);
  const emptyTags = ordered.filter((b) => b.results.length === 0).map((b) => tagOf(b.run.id));

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col text-[12px]">
        <ProjectBreadcrumb projectId={projectId} current="Run Comparison" />

        {/* Search, then the runs, whose menu also picks the baseline. */}
        <CaseToolbar
          keyword={keyword}
          onChangeKeyword={setKeyword}
          runs={
            <RunsMenu
              count={runIds.length}
              open={runsMenu}
              onOpenChange={setRunsMenu}
              legend={
                baseline
                  ? {
                      projectId,
                      runs: ordered,
                      baselineRunId: model.baselineRunId,
                      dotFor,
                      tagOf,
                      canRemove: runIds.length > 2,
                      onSetBaseline: onChangeBaseline,
                      onRemove: (runId) => {
                        const runs = runIds.filter((id) => id !== runId);
                        // Without a baseline in the URL, the oldest run left takes over.
                        onChangeRuns(
                          runs,
                          runId === model.baselineRunId ? null : model.baselineRunId,
                        );
                      },
                    }
                  : null
              }
              picker={
                baseline && newest
                  ? {
                      projectId,
                      selectedIds: runIds,
                      anchor: newest.run,
                      datasetId: baseline.run.datasetId,
                      // Pin the baseline in use, so an older run added without one in the
                      // URL doesn't become the default baseline.
                      onPick: (run) => onChangeRuns([...runIds, run.id], model.baselineRunId),
                    }
                  : null
              }
            />
          }
        />

        {runIds.length < 2 ? (
          <div className="p-3">
            <EmptyState>Select at least two runs to compare.</EmptyState>
          </div>
        ) : isLoading ? (
          <div className="p-3">
            <EmptyState>Comparing…</EmptyState>
          </div>
        ) : isError || ordered.length !== runIds.length || !baseline ? (
          <div className="p-3">
            <EmptyState>Couldn’t load one or more of these runs.</EmptyState>
          </div>
        ) : !hasPairedCases(model) ? (
          <div className="p-3">
            <EmptyState>
              {emptyTags.length > 0 && ordered.length - emptyTags.length < 2
                ? noResultsText(emptyTags)
                : crossDataset
                  ? `These runs are on different datasets (${datasetNames.join(", ")}) and share no inputs in common.`
                  : "These runs share no dataset rows — their dataset versions have no rows in common."}
            </EmptyState>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <ScopeLine model={model} tagOf={tagOf} />
            <div className="min-h-0 flex-1 overflow-auto">
              <Table className={COMPARISON_TABLE}>
                <ComparisonHead model={model} />
                <SummaryGroup
                  model={model}
                  pairs={pairs}
                  dotFor={dotFor}
                  labelOf={labelOf}
                  tagOf={tagOf}
                />
                <ComparisonBody
                  model={model}
                  baseline={baseline}
                  rows={visible}
                  pairs={pairs}
                  dotFor={dotFor}
                  labelOf={labelOf}
                  tagOf={tagOf}
                />
              </Table>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
