"use client";

import { useParams, useSearchParams } from "next/navigation";
import type { CaseAnalysis } from "@/features/evaluations/compare/filters";
import {
  parseCompareUrl,
  serializeCompareUrl,
  type CompareUrlState,
} from "@/features/evaluations/compare/url-state";
import { CompareRunsView } from "@/features/evaluations/views/compare-runs-view";

// Shareable comparison route (the parameters are in `compare/url-state`). The static
// `compare` segment takes priority over the sibling `[runId]` route, so run-detail URLs
// are unaffected. The run set + baseline live in the URL so the view is shareable and
// works with browser back/forward; so do the table's search, filters and sort, so a
// reload or a shared link lands on the same view.
export default function CompareRunsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  const url = parseCompareUrl(searchParams);

  // Everything on this page is read on the client, so the URL changes through the history
  // API, which the app router keeps `useSearchParams` and back/forward in step with. Each
  // write starts from the address bar as it is now, not as the page last rendered it: two
  // writes can land before a render (a search settling just after a baseline change), and
  // the second must keep the first. Parameters the page doesn't own are kept too.
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
  // the view hands them over (less any the change leaves with nothing to pick).
  const setBaseline = (baseline: string | null, analysis?: CaseAnalysis) =>
    write("push", () => ({ baseline, ...analysis }));
  // The view names the baseline it compared against, so adding an older run can't move it.
  // A baseline no longer compared leaves the URL, so the oldest run takes over.
  const setRuns = (runs: string[], baseline: string | null, analysis?: CaseAnalysis) =>
    write("push", () => ({
      runs,
      baseline: baseline && runs.includes(baseline) ? baseline : null,
      ...analysis,
    }));

  // The search, filters and sort, which the view writes as they settle, replace the entry
  // instead of adding one, so refining them doesn't take a press of Back per change to
  // leave the page.
  const analyze = ({ q, filters, sort }: CaseAnalysis) =>
    write("replace", () => ({ q, filters, sort }));

  return (
    <CompareRunsView
      projectId={projectId}
      runIds={url.runs}
      baselineId={url.baseline}
      onChangeBaseline={setBaseline}
      onChangeRuns={setRuns}
      analysis={{ q: url.q, filters: url.filters, sort: url.sort }}
      onChangeAnalysis={analyze}
    />
  );
}
