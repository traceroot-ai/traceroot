"use client";

import { useParams, useSearchParams } from "next/navigation";
import type { CaseAnalysis } from "@/features/evaluations/compare/filters";
import type { InspectedCase } from "@/features/evaluations/compare/inspector";
import {
  parseCompareUrl,
  serializeCompareUrl,
  type CompareUrlState,
} from "@/features/evaluations/compare/url-state";
import { CompareRunsView } from "@/features/evaluations/views/compare-runs-view";

// Shareable comparison route (the parameters are in `compare/url-state`). The static
// `compare` segment takes priority over the sibling `[runId]` route, so run-detail URLs
// are unaffected. The run set + baseline live in the URL so the view is shareable and
// works with browser back/forward; so do the table's search, filters and sort, and the
// case open in the trace panel with the two runs it compares, so a reload or a shared
// link lands on the same view.
export default function CompareRunsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  const url = parseCompareUrl(searchParams);
  const inspected: InspectedCase | null = url.case ? { caseToken: url.case, pair: url.pair } : null;

  // Everything on this page is read on the client, so the URL changes through the history
  // API, which the app router keeps `useSearchParams` and back/forward in step with. Each
  // write starts from the address bar as it is now, not as the page last rendered it: two
  // writes can land before a render (a filter settling as a case opens), and the second
  // must keep the first. Parameters the page doesn't own are kept too.
  const write = (
    mode: "push" | "replace",
    change: (before: CompareUrlState) => Partial<CompareUrlState>,
  ) => {
    const current = new URLSearchParams(window.location.search);
    const before = parseCompareUrl(current);
    const qs = serializeCompareUrl({ ...before, ...change(before) }, current);
    // A change that changes nothing adds no history entry.
    if (qs === serializeCompareUrl(before, current)) return;
    const href = `/projects/${projectId}/evaluations/compare${qs ? `?${qs}` : ""}`;
    if (mode === "push") window.history.pushState(null, "", href);
    else window.history.replaceState(null, "", href);
  };

  // Runs and the baseline add a history entry, with the table's search, filters and sort as
  // the view hands them over (less any the change leaves with nothing to pick). The trace
  // panel's pair follows the table onto a new baseline when it was on the one replaced; a
  // pair picked in the panel stays.
  const setBaseline = (baseline: string | null, analysis?: CaseAnalysis, replaced?: string) =>
    write("push", (before) => ({
      baseline,
      ...analysis,
      pair: before.pair && before.pair[0] === replaced ? null : before.pair,
    }));
  // The view names the baseline it compared against, so adding an older run can't move it.
  // A baseline no longer compared leaves the URL, so the oldest run takes over. A pair
  // naming a run that left leaves it too, and the open case shows on the default pair.
  const setRuns = (runs: string[], baseline: string | null, analysis?: CaseAnalysis) =>
    write("push", (before) => ({
      runs,
      baseline: baseline && runs.includes(baseline) ? baseline : null,
      ...analysis,
      pair: before.pair?.every((id) => runs.includes(id)) ? before.pair : null,
    }));

  // Opening, stepping through and closing cases replaces the entry instead of adding one,
  // so walking a hundred cases doesn't take a hundred presses of Back to leave the page.
  // The same goes for the search, filters and sort, which the view writes as they settle.
  const inspect = (next: InspectedCase | null) =>
    write("replace", () => ({ case: next?.caseToken ?? null, pair: next?.pair ?? null }));
  const analyze = ({ q, filters, sort }: CaseAnalysis) =>
    write("replace", () => ({ q, filters, sort }));

  return (
    <CompareRunsView
      projectId={projectId}
      runIds={url.runs}
      baselineId={url.baseline}
      onChangeBaseline={setBaseline}
      onChangeRuns={setRuns}
      inspected={inspected}
      onInspect={inspect}
      analysis={{ q: url.q, filters: url.filters, sort: url.sort }}
      onChangeAnalysis={analyze}
    />
  );
}
