// @vitest-environment jsdom
/**
 * View-mount ("e2e") smoke for the real, server-backed Datasets + Evaluations
 * pages. The routes sit behind auth and can't be driven over HTTP
 * without a session, and the repo has no browser driver — so mounting the views
 * against a stubbed fetch (server-shaped payloads) is how the browser path is
 * checked, exactly like offline-eval.smoke.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", datasetId: "ds1", runId: "run1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/evaluations",
}));
// ProjectBreadcrumb pulls layout/workspace context we don't mount here.
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

import { DatasetsView } from "./views/datasets-view";
import { EvaluationsView } from "./views/evaluations-view";
import { RunDetailView } from "./views/run-detail-view";
import { DatasetDetailView } from "./views/dataset-detail-view";
import type { RunDetail } from "./types";

/**
 * Matches the innermost element whose *combined* text matches `re`.
 *
 * Several of these strings are deliberately split across elements: the run
 * number is a keyboard-accessible <Link> followed by " · candidate", the
 * datasets error is followed by a "Try again" button, and the not-found copy
 * interpolates the id. A plain string/regex matcher only ever sees one text
 * node, so it cannot match any of them.
 */
const withText = (re: RegExp) => (_content: string, el: Element | null) =>
  !!el &&
  re.test(el.textContent ?? "") &&
  !Array.from(el.children).some((c) => re.test(c.textContent ?? ""));


const RUN = {
  id: "run1",
  evaluationId: "eval1",
  datasetId: "ds1",
  datasetVersionId: "dv1",
  runNumber: 27,
  candidateVersion: "git:4a91c02",
  environment: "ci",
  status: "completed_with_errors",
  baselineRunId: "run0",
  mainScore: 0.938,
  mainScoreName: "Routing accuracy",
  caseCount: 24,
  scoredCount: 22,
  taskErrorCount: 1,
  scorerErrorCount: 1,
  // Matches caseCount (24): 22 passed, 0 failed, 1 errored, 1 not-scored. Real
  // fixtures must carry these — the list route emits them unconditionally and
  // PassRate's fraction/percentage render NaN when they're missing (see the
  // "Passed column renders a real fraction" test below).
  passedCount: 22,
  failedCount: 0,
  erroredCount: 1,
  notScoredCount: 1,
  cost: 0.264,
  scorers: [{ name: "routing-accuracy", version: "v3" }],
  model: null,
  startedAt: "2026-07-17T10:24:00Z",
  completedAt: "2026-07-17T10:30:00Z",
  evaluationName: "Billing routing",
  datasetName: "Billing routing",
  datasetVersionLabel: "v12",
  changeFromBaseline: 0.224,
  errorCount: 2,
  baselineComparable: true,
  elapsedMs: 360000,
  comparison: {
    available: true,
    trustworthy: true,
    reasons: [],
    baseline: { runId: "run0", runNumber: 26, candidateVersion: "git:0000000" },
    mainScore: { candidate: 0.938, baseline: 0.714, delta: 0.224 },
    caseCounts: {
      improved: 1,
      regressed: 0,
      unchanged: 21,
      changed: 0,
      unpaired: 0,
      not_comparable: 0,
    },
    scoreCellCounts: {
      improved: 1,
      regressed: 0,
      unchanged: 21,
      changed: 0,
      unpaired: 0,
      not_comparable: 0,
    },
    scorers: [
      {
        name: "routing-accuracy",
        version: "v3",
        valueType: "numeric",
        direction: "higher_is_better",
        candidateMean: 0.938,
        baselineMean: 0.714,
        delta: 0.224,
        pairedCount: 22,
      },
    ],
    duration: { candidateMeanMs: 1500, baselineMeanMs: 1400, deltaMs: 100, pairedCount: 22 },
  },
} satisfies RunDetail;

const RESULT = {
  id: "res1",
  runId: "run1",
  evaluationId: "eval1",
  testCaseId: "case-1",
  traceId: "tr_1",
  input: "I was charged twice for my July invoice",
  expectedOutput: "billing",
  candidateOutput: "billing",
  baselineOutput: "account-management",
  status: "passed",
  mainScore: 1,
  change: "improved",
  taskError: null,
  durationMs: 2400,
  cost: 0.012,
  createTime: "2026-07-17T10:24:00Z",
  scores: [
    {
      id: "s1",
      scorerName: "routing-accuracy",
      scorerVersion: "v3",
      numericValue: 1,
      boolValue: null,
      stringValue: null,
      passed: null,
      explanation: "Reached billing",
      error: null,
    },
  ],
  humanScores: [],
  comparison: {
    caseChange: "improved",
    pairing: "paired",
    mainScore: { candidate: 1, baseline: 0, delta: 1 },
    scorerCells: [
      {
        scorerName: "routing-accuracy",
        scorerVersion: "v3",
        valueType: "numeric",
        direction: "higher_is_better",
        candidateValue: 1,
        baselineValue: 0,
        delta: 1,
        classification: "improved",
      },
    ],
    regressedCellCount: 0,
    comparableCellCount: 1,
  },
};

// An older run of the SAME evaluation lineage, distinct candidate, so grouping and
// latest-only are meaningful in the run-centric table.
const RUN_OLDER = {
  ...RUN,
  id: "run0",
  runNumber: 26,
  candidateVersion: "git:0000000",
  startedAt: "2026-07-16T10:24:00Z",
  completedAt: "2026-07-16T10:30:00Z",
  changeFromBaseline: null,
  baselineRunId: null,
};

function payloadFor(url: string): unknown {
  if (url.includes("/evaluations/runs/run1")) return { run: RUN, results: [RESULT] };
  if (url.includes("/evaluations/runs"))
    return { data: [RUN, RUN_OLDER], meta: { page: 0, limit: 50, total: 2 } };
  if (url.includes("/evaluations/scorers"))
    return {
      data: [
        {
          name: "routing-accuracy",
          version: "v3",
          scoreCount: 22,
          errorCount: 0,
          errorRate: 0,
          valueType: "numeric",
          declaredValueType: "numeric",
          direction: "higher_is_better",
          threshold: null,
          numeric: { mean: 0.9, min: 0.5, max: 1, count: 22 },
          passRate: null,
          distribution: null,
          runCount: 2,
          evaluationCount: 1,
          lastUsed: "2026-07-17T10:24:00Z",
          recentErrors: [],
          source: "SDK",
        },
      ],
    };
  if (url.includes("/evaluations")) {
    return {
      data: [
        {
          id: "eval1",
          name: "Billing routing",
          datasetId: "ds1",
          mainScoreName: "Routing accuracy",
          datasetName: "Billing routing",
          runCount: 1,
          latestRun: {
            id: "run1",
            runNumber: 27,
            candidateVersion: "git:4a91c02",
            status: "completed_with_errors",
            mainScore: 0.938,
            startedAt: "2026-07-17T10:24:00Z",
            datasetVersionId: "dv1",
          },
        },
      ],
    };
  }
  if (url.match(/\/datasets\/ds1$/)) {
    const version = {
      id: "dv1",
      datasetId: "ds1",
      projectId: "p1",
      versionNumber: 1,
      label: "v1",
      note: null,
      createdBy: null,
      createTime: "2026-07-16T00:00:00Z",
    };
    return {
      dataset: {
        id: "ds1",
        projectId: "p1",
        name: "Billing routing",
        description: null,
        currentVersionId: "dv1",
        createTime: "2026-07-16T00:00:00Z",
        updateTime: "2026-07-17T00:00:00Z",
        caseCount: 2,
        versionCount: 1,
      },
      currentVersion: version,
      // The requested (here, current) version and whether it's current — both
      // required by DatasetDetailResponse; DatasetDetailView reads them directly
      // (types.ts:94-96).
      selectedVersion: version,
      isCurrentVersion: true,
      testCases: [],
      versions: [version],
    };
  }
  if (url.includes("/datasets")) {
    return {
      data: [
        {
          id: "ds1",
          projectId: "p1",
          name: "Billing routing",
          description: "Routing tickets",
          currentVersionId: "dv1",
          createTime: "2026-07-16T00:00:00Z",
          updateTime: "2026-07-17T00:00:00Z",
          caseCount: 8,
          versionCount: 3,
        },
      ],
      meta: { page: 0, limit: 50, total: 1 },
    };
  }
  return {};
}

beforeEach(() => {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: async () => payloadFor(String(url)),
  })) as unknown as typeof fetch;
});
afterEach(() => cleanup());

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The real /datasets and /evaluations route subtrees mount a ToastProvider;
  // the views use toasts, so the harness mirrors that wrapping.
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe("real Datasets + Evaluations views render server data", () => {
  it("Datasets list shows a server dataset", async () => {
    mount(<DatasetsView projectId="p1" />);
    expect(await screen.findByText("Billing routing")).toBeDefined();
  });

  it("Evaluations Runs tab shows a run with its candidate version", async () => {
    mount(<EvaluationsView projectId="p1" />);
    expect((await screen.findAllByText("git:4a91c02")).length).toBeGreaterThan(0);
  });

  it("Evaluations shows an empty state that points at the SDK (no Run evaluation CTA)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    })) as unknown as typeof fetch;
    mount(<EvaluationsView projectId="p1" />);
    expect(await screen.findByText(/No evaluation runs yet/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Run evaluation/ })).toBeNull();
  });

  it("run-centric table shows immutable-run identity (Run # + candidate) for both runs", async () => {
    mount(<EvaluationsView projectId="p1" />);
    expect(await screen.findByText(withText(/Run #27 ·/))).toBeDefined();
    expect(await screen.findByText(withText(/Run #26 ·/))).toBeDefined();
  });

  it("Passed column renders a real fraction from result-status counts, not undefined/NaN", async () => {
    mount(<EvaluationsView projectId="p1" />);
    await screen.findByText(withText(/Run #27 ·/));
    // Both runs carry passedCount:22/failedCount:0 (of caseCount 24; 1 errored,
    // 1 not-scored excluded from the fraction) — one "22/22" per flat run row.
    // Before the fixture had these counts, this cell silently rendered
    // "undefined/NaN" / "NaN%" instead (lib/eval/pass-rate.ts: passRate(undefined,
    // undefined) => NaN, which is not `=== 0` so the null/"—" guard never fires).
    expect(screen.getAllByText("22/22").length).toBe(2);
    expect(screen.getAllByText("100.0%").length).toBe(2);
  });

  it("Latest only keeps just the newest run of each lineage", async () => {
    mount(<EvaluationsView projectId="p1" />);
    // Both runs visible first.
    expect(await screen.findByText("git:0000000")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Latest only/ }));
    // The older run (#26) drops out; the newest (#27) stays.
    expect(screen.queryByText("git:0000000")).toBeNull();
    expect(screen.getByText("git:4a91c02")).toBeDefined();
  });

  it("Group by evaluation collapses runs under a lineage header", async () => {
    mount(<EvaluationsView projectId="p1" />);
    await screen.findByText(withText(/Run #27 ·/));
    fireEvent.click(screen.getByRole("button", { name: /Group by evaluation/ }));
    // Group header shows per-column aggregate totals across the lineage (not the latest
    // run's values): run count, the averaged main score, and total captions.
    expect(await screen.findByText(/2 runs/)).toBeDefined();
    expect(screen.getByText(/93\.8%/)).toBeDefined(); // avg main score across the lineage
    // Two "total" captions: pooled cost (both runs report a cost) and pooled
    // duration — not just duration alone, which is what a zero-cost fixture
    // silently degraded to.
    expect(screen.getAllByText("total").length).toBe(2);
    // Pooled pass rate across both runs' counts (44 passed / 44 judged), not the
    // zero-denominator "—" fallback aggregateGroup produces when the fixture
    // carries no passedCount/failedCount at all.
    expect(screen.getByText("44/44")).toBeDefined();
  });

  it("renders a non-empty status badge even for a run status the UI's own type omits", async () => {
    // The backend accepts "cancelled" (backend/rest/schemas/eval.py) and the list
    // route spreads a run's status through untouched, but EvalRunStatus /
    // STATUS_VARIANT / EVAL_RUN_STATUS_LABEL (types.ts, evaluations-view.tsx) don't
    // have a "cancelled" key — so, unlike compare-runs.smoke.test.tsx (which stubs
    // RunStatusBadge to echo the raw string and never exercises this), the REAL
    // badge here renders <Badge variant={undefined}>{undefined}</Badge>: visually
    // empty. `as never` bypasses the type system the same way a value the backend
    // actually sends would arrive at runtime — TypeScript can't stop it.
    const RUN_CANCELLED = { ...RUN, id: "run-cancelled", status: "cancelled" as never };
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [RUN_CANCELLED], meta: { page: 0, limit: 50, total: 1 } }),
    })) as unknown as typeof fetch;
    mount(<EvaluationsView projectId="p1" />);
    const row = (await screen.findByText(withText(/Run #27 ·/))).closest("tr") as HTMLTableRowElement;
    const statusCell = within(row).getAllByRole("cell")[6];
    expect(statusCell.textContent?.trim()).not.toBe("");
  });

  it("Scorers tab shows an SDK-defined scorer and opens its read-only detail", async () => {
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Scorers/ }));
    // Clicking a scorer row opens the read-only, detector-style detail panel.
    fireEvent.click(await screen.findByText("routing-accuracy"));
    const detail = await screen.findByLabelText("Scorer detail");
    // Detector-style cards; the removed analytics block is gone.
    expect(within(detail).getByText("Name")).toBeDefined();
    expect(within(detail).getByText("Pass threshold")).toBeDefined();
    expect(within(detail).queryByText("Observed usage")).toBeNull();
    expect(within(detail).queryByText("Configuration")).toBeNull();
    // Scorers are SDK-authored — no create/edit control.
    expect(screen.queryByRole("button", { name: /Create scorer/ })).toBeNull();
  });

  it("Run detail renders the run header and the result row (results-forward)", async () => {
    mount(<RunDetailView projectId="p1" runId="run1" />);
    // The run's identity (evaluation name + candidate version) in the header.
    expect((await screen.findAllByText("Billing routing")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("git:4a91c02")).length).toBeGreaterThan(0);
    // The result row is present (the hero results table shows the case input).
    expect((await screen.findAllByText(/charged twice/)).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Loading / error / empty states. The issue AC ("Each surface has a mount
// smoke test covering loading / empty / error / populated") and the PR body
// both claimed this file asserted all four for every surface; before this,
// only the populated leg (plus one empty-runs case above) was ever exercised,
// so e.g. swapping the isLoading/error branches in run-detail-view.tsx:400-404
// — or dropping any surface's `error ?` leg entirely — passed the whole suite.
// ---------------------------------------------------------------------------
describe("loading / error / empty states", () => {
  // A fetch that never resolves — isLoading stays true for the assertion.
  const pendingFetch = () =>
    vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const failingFetch = (status = 500) =>
    vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({ error: "boom" }),
    })) as unknown as typeof fetch;
  const emptyListFetch = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    })) as unknown as typeof fetch;

  it("Datasets shows a loading state while the fetch is in flight", () => {
    global.fetch = pendingFetch();
    mount(<DatasetsView projectId="p1" />);
    expect(screen.getByText("Loading datasets...")).toBeDefined();
  });

  it("Datasets shows an error state when the fetch fails", async () => {
    global.fetch = failingFetch();
    mount(<DatasetsView projectId="p1" />);
    expect(await screen.findByText(withText(/Error loading datasets/))).toBeDefined();
  });

  it("Datasets shows an empty state pointing at saving a trace/span as a test case", async () => {
    global.fetch = emptyListFetch();
    mount(<DatasetsView projectId="p1" />);
    expect(await screen.findByText(/No datasets yet/)).toBeDefined();
  });

  it("Evaluations Runs tab shows a loading state while the fetch is in flight", () => {
    global.fetch = pendingFetch();
    mount(<EvaluationsView projectId="p1" />);
    expect(screen.getByText("Loading runs...")).toBeDefined();
  });

  it("Evaluations Runs tab shows an error state when the fetch fails", async () => {
    global.fetch = failingFetch();
    mount(<EvaluationsView projectId="p1" />);
    expect(await screen.findByText("Error loading runs")).toBeDefined();
  });

  it("Scorers tab shows loading, error, and empty states", async () => {
    global.fetch = pendingFetch();
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Scorers/ }));
    expect(screen.getByText("Loading scorers...")).toBeDefined();
    cleanup();

    global.fetch = failingFetch();
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Scorers/ }));
    expect(await screen.findByText("Error loading scorers")).toBeDefined();
    cleanup();

    global.fetch = emptyListFetch();
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Scorers/ }));
    expect(await screen.findByText(/No scorers yet/)).toBeDefined();
  });

  it("Run detail shows a loading state, then a not-found state on error", async () => {
    global.fetch = pendingFetch();
    mount(<RunDetailView projectId="p1" runId="run1" />);
    expect(screen.getByText("Loading run...")).toBeDefined();
    cleanup();

    global.fetch = failingFetch(404);
    mount(<RunDetailView projectId="p1" runId="run1" />);
    expect(await screen.findByText("Evaluation run not found")).toBeDefined();
    expect(screen.getByText("Back to evaluations")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dataset detail — of the five routed evaluation surfaces (datasets,
// datasets/[datasetId], evaluations, evaluations/[runId], evaluations/compare),
// this was the only one with zero mount coverage: `payloadFor`'s
// `/datasets/ds1$` branch above was built and never used by any test, so this
// suite's own claim to "Mount smoke tests for Datasets, Evaluations, Run
// detail, Comparison, and Scorers" was false for Datasets' detail route.
// ---------------------------------------------------------------------------
describe("real Dataset detail view renders server data", () => {
  it("shows the dataset identity and its (empty) test-case table", async () => {
    mount(<DatasetDetailView projectId="p1" datasetId="ds1" />);
    expect((await screen.findAllByText("Billing routing")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/No test cases yet/)).toBeDefined();
  });

  it("shows a loading state while the fetch is in flight", () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    mount(<DatasetDetailView projectId="p1" datasetId="ds1" />);
    expect(screen.getByText("Loading dataset...")).toBeDefined();
  });

  it("shows a not-found state for an unknown dataset", async () => {
    // A real 404 — the view distinguishes "this dataset does not exist" from
    // "the request failed", and only the former gets the not-found copy. A 200
    // with an empty body is a malformed response, not a missing dataset, so it
    // correctly renders the generic "Couldn't load dataset" state instead.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    mount(<DatasetDetailView projectId="p1" datasetId="missing-ds" />);
    expect(await screen.findByText(withText(/No dataset with the id missing-ds/))).toBeDefined();
    expect(screen.getByText("Back to datasets")).toBeDefined();
  });
});
