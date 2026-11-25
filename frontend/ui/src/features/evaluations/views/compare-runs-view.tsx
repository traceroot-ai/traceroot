"use client";

import * as React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Table } from "@/components/ui/table";
import { EmptyState } from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useEvaluationRunDetails } from "../hooks";
import { COMPARISON_TABLE } from "../compare/cells";
import { cutAtLimit, hasPairedCases, noResultsText, partialRunNotes } from "../compare/coverage";
import { NoSharedInputs, RunsNotLoaded } from "../compare/empty-states";
import {
  clearLabel,
  clearSearchAndFilters,
  isFiltering,
  NO_ANALYSIS,
  pruneForRuns,
  selectCases,
  toggleFilter,
  type CaseAnalysis,
} from "../compare/filters";
import { InspectorHost, useCaseInspector, type InspectedCase } from "../compare/inspector";
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
import { useCaseAnalysis } from "../compare/use-analysis";
import { useDisplay } from "../compare/use-display";

// A run comparison is N runs (2+) lined up case-by-case, anchored on the baseline run
// (alignment lives in `../compare/model`). Each case is a group of lines, one per run,
// the baseline's first; against it every other run's line also shows a green/red
// improvement/regression change. A line opens its case in the trace panel, two runs at a
// time.

export function CompareRunsView({
  projectId,
  runIds,
  baselineId,
  onChangeBaseline,
  onChangeRuns,
  inspected,
  onInspect,
  analysis: fromUrl = NO_ANALYSIS,
  onChangeAnalysis,
}: {
  projectId: string;
  runIds: string[];
  baselineId: string | null;
  /** The baseline, with the search, filters and sort to write along with it, and the
   *  baseline it replaces. */
  onChangeBaseline: (baselineId: string | null, analysis?: CaseAnalysis, replaced?: string) => void;
  /** The runs to compare, in the order they were selected, and the baseline to keep: the
   *  one being compared against, or null when it was removed; with the search, filters
   *  and sort to write along with them. */
  onChangeRuns: (runIds: string[], baselineId: string | null, analysis?: CaseAnalysis) => void;
  inspected: InspectedCase | null;
  onInspect: (next: InspectedCase | null) => void;
  /** The table's search, filters and sort, as the URL holds them. */
  analysis?: CaseAnalysis;
  /** Writes them back once a change settles. */
  onChangeAnalysis?: (next: CaseAnalysis) => void;
}) {
  const queries = useEvaluationRunDetails(projectId, runIds);
  // Back or forward onto other runs or another baseline starts over from the URL.
  const place = JSON.stringify([runIds, baselineId]);
  const [analysis, setAnalysis, commitAnalysis] = useCaseAnalysis(fromUrl, onChangeAnalysis, place);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [display, setDisplay] = useDisplay(projectId);
  // The Runs menu opens from its button, or on its picker from the empty state of runs
  // with nothing in common.
  const [runsMenu, setRunsMenu] = React.useState<RunsMenuView | null>(null);
  const filtersButton = React.useRef<HTMLButtonElement>(null);

  const isLoading = queries.some((q) => q.isLoading);
  // Selected runs whose read settled with nothing to show.
  const failed = isLoading ? [] : queries.filter((q) => !q.data);

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

  // Rows = every case any run has, in baseline order, that the search and filters pick.
  // The toolbar shows each keystroke at once; the rows and the summary follow when React
  // has the time, so typing in a long comparison doesn't wait on the table.
  const shownAnalysis = React.useDeferredValue(analysis);
  const visible = React.useMemo(
    () => selectCases(model, pairs, shownAnalysis),
    [model, pairs, shownAnalysis],
  );

  // With a search or filters on, the summary covers exactly the cases they leave.
  const filtering = isFiltering(shownAnalysis);
  const summaryPairs = React.useMemo(
    () => (filtering ? comparePairs(model, new Set(visible.map((c) => c.key))) : pairs),
    [filtering, model, pairs, visible],
  );

  // A change of runs or baseline takes the table's analysis with it, a change not yet
  // written included, less the filters and sort it leaves with nothing to pick.
  const analysisFor = (runs: string[], nextBaseline: string) => {
    // When every run it keeps is loaded, the comparison it leaves is known, so filters and a
    // sort on a scorer or a direction it no longer has go too.
    const kept = loaded.filter((b) => runs.includes(b.run.id));
    const nextModel = kept.length === runs.length ? buildCompareModel(kept, nextBaseline) : null;
    const next = pruneForRuns(
      analysis,
      runs,
      nextBaseline,
      nextModel && { scorers: nextModel.scorers, pairs: comparePairs(nextModel) },
    );
    commitAnalysis(next);
    return next;
  };

  const inspector = useCaseInspector({ projectId, model, rows: visible, inspected, onInspect });
  // Stable while the runs are, so the memoized rows don't re-render on every keystroke.
  const tagOf = React.useMemo(() => runTagger(ordered), [ordered]);
  const labelOf = React.useMemo(() => runLabeler(ordered, tagOf), [ordered, tagOf]);
  // Runs with no results; with fewer than two runs left, that is why nothing is compared.
  const emptyTags = ordered.filter((b) => b.results.length === 0).map((b) => tagOf(b.run.id));
  const tooFewWithResults = emptyTags.length > 0 && ordered.length - emptyTags.length < 2;
  // Runs to add are suggested from before the newest one compared.
  const newest = newestRun(ordered);
  // Export covers the table, so it waits for one: why, while the branches below show
  // something else in its place.
  const exportOff =
    runIds.length < 2
      ? "No comparison to export"
      : isLoading
        ? "Available once the runs load"
        : failed.length > 0 || !baseline
          ? "No comparison to export"
          : !hasPairedCases(model)
            ? "These runs have no matching inputs"
            : null;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col text-[12px]">
        <ProjectBreadcrumb projectId={projectId} current="Run Comparison" />

        {/* Search, filters, sort, layout and the runs (whose menu also picks the
            baseline), then export. */}
        <CaseToolbar
          projectId={projectId}
          model={model}
          pairs={pairs}
          searchRef={searchRef}
          cases={visible}
          casesAnalysis={shownAnalysis}
          exportOff={exportOff}
          analysis={analysis}
          onChange={setAnalysis}
          tagOf={tagOf}
          disabled={isLoading}
          filtersRef={filtersButton}
          display={display}
          onChangeDisplay={setDisplay}
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
                      onSetBaseline: (id) =>
                        onChangeBaseline(id, analysisFor(runIds, id), model.baselineRunId),
                      onRemove: (runId) => {
                        const runs = runIds.filter((id) => id !== runId);
                        const keep = runId === model.baselineRunId ? null : model.baselineRunId;
                        // Without one, the oldest run left takes over (`ordered` is by age
                        // after the baseline).
                        const next = keep ?? ordered.find((b) => runs.includes(b.run.id))?.run.id;
                        onChangeRuns(runs, keep, analysisFor(runs, next ?? ""));
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
                      onPick: (run) => {
                        const runs = [...runIds, run.id];
                        onChangeRuns(
                          runs,
                          model.baselineRunId,
                          analysisFor(runs, model.baselineRunId),
                        );
                      },
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
        ) : failed.length > 0 || !baseline ? (
          <div className="p-3">
            <RunsNotLoaded
              count={failed.length}
              onRemove={
                loaded.length > 0
                  ? () => {
                      const runs = runIds.filter((_, i) => queries[i]?.data);
                      // The loaded runs' baseline is the one left in charge.
                      onChangeRuns(runs, baselineId, analysisFor(runs, model.baselineRunId));
                      // The button unmounts with the error panel; keep focus in the page.
                      searchRef.current?.focus();
                    }
                  : undefined
              }
              onRetry={() => {
                failed.forEach((q) => void q.refetch());
                searchRef.current?.focus();
              }}
            />
          </div>
        ) : !hasPairedCases(model) ? (
          <div className="p-3">
            <NoSharedInputs
              detail={
                tooFewWithResults
                  ? noResultsText(emptyTags)
                  : crossDataset
                    ? `These runs are on different datasets (${datasetNames.join(", ")}) and share no inputs in common.`
                    : "These runs share no dataset rows — their dataset versions have no rows in common."
              }
              // A run cut off at the result limit may share inputs past what loaded; with
              // fewer than two runs holding results, none could pair anyway.
              cutNotes={tooFewWithResults ? [] : partialRunNotes(ordered.filter(cutAtLimit), tagOf)}
              canRemove={runIds.length > 2}
              onAddRuns={() => setRunsMenu("add")}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <ScopeLine model={model} matching={filtering ? visible.length : null} tagOf={tagOf} />
            <div ref={inspector.tableRef} className="min-h-0 flex-1 overflow-auto">
              <Table className={COMPARISON_TABLE}>
                <ComparisonHead model={model} display={display} />
                <SummaryGroup
                  model={model}
                  pairs={summaryPairs}
                  dotFor={dotFor}
                  labelOf={labelOf}
                  tagOf={tagOf}
                  filters={analysis.filters}
                  onToggleFilter={(f) =>
                    setAnalysis({ ...analysis, filters: toggleFilter(analysis.filters, f) })
                  }
                  display={display}
                  filtering={filtering}
                />
                <ComparisonBody
                  model={model}
                  baseline={baseline}
                  rows={visible}
                  pairs={pairs}
                  dotFor={dotFor}
                  labelOf={labelOf}
                  tagOf={tagOf}
                  display={display}
                  rowProps={inspector.rowProps}
                  clearLabel={clearLabel(analysis)}
                  onClear={() => {
                    setAnalysis(clearSearchAndFilters(analysis));
                    // This button goes with the empty table; focus goes where the
                    // toolbar's Clear sends it.
                    filtersButton.current?.focus();
                  }}
                />
              </Table>
            </div>
            <InspectorHost inspector={inspector} tagOf={tagOf} dotFor={dotFor} />
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
