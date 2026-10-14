// @vitest-environment jsdom
/**
 * View-mount ("e2e") smoke for the real, server-backed Datasets + Evaluations
 * pages. The routes sit behind auth and can't be driven over HTTP
 * without a session, and the repo has no browser driver — so mounting the views
 * against a stubbed fetch (server-shaped payloads) is how the browser path is
 * checked, exactly like offline-eval.smoke.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

// One stable router so a test can assert what a click navigated to (e.g. the
// compare route). Cleared in beforeEach.
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", datasetId: "ds1", runId: "run1" }),
  useRouter: () => nav,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/evaluations",
}));
// ProjectBreadcrumb pulls layout/workspace context we don't mount here.
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

import { DatasetsView } from "./views/datasets-view";
import { EvaluationsView } from "./views/evaluations-view";
import { RunDetailView } from "./views/run-detail-view";
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
  caseCount: 24,
  scoredCount: 22,
  taskErrorCount: 1,
  scorerErrorCount: 1,
  // The unscorable slice of caseCount (24): 1 errored, 1 not-scored. The remaining
  // 22 produced scores; there is no case-level pass/fail to count. The list route
  // emits both counts unconditionally, so real fixtures must carry them.
  erroredCount: 1,
  notScoredCount: 1,
  cost: 0.264,
  scorers: [{ name: "routing-accuracy", version: "v3" }],
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
    state: "trustworthy",
    reasons: [],
    baseline: { runId: "run0", runNumber: 26, candidateVersion: "git:0000000" },
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
  metadata: null,
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
  comparison: {
    pairing: "paired",
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
          datasetName: "Billing routing",
          runCount: 1,
          latestRun: {
            id: "run1",
            runNumber: 27,
            candidateVersion: "git:4a91c02",
            status: "completed_with_errors",
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
  nav.push.mockClear();
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

  it("run-centric table shows both runs by run number + candidate version", async () => {
    mount(<EvaluationsView projectId="p1" />);
    // Run Name is "<number> <candidate version>"; candidate versions uniquely
    // identify the two runs (#27 → git:4a91c02, #26 → git:0000000).
    expect(await screen.findByText("git:4a91c02")).toBeDefined();
    expect(screen.getByText("git:0000000")).toBeDefined();
  });

  it("the run action menu deletes a run after confirming", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      return { ok: true, status: 200, json: async () => payloadFor(String(url)) };
    }) as unknown as typeof fetch;
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click((await screen.findAllByLabelText("Row actions"))[0]);
    fireEvent.click(await screen.findByText("Delete"));
    // Confirmation first — nothing is deleted until the dialog's Delete is clicked.
    await screen.findByText("Delete run");
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await waitFor(() =>
      expect(
        requests.some((r) => r.method === "DELETE" && r.url.includes("/evaluations/runs/")),
      ).toBe(true),
    );
    expect(await screen.findByText("Run deleted")).toBeDefined();
  });

  it("compares a cross-dataset selection with no refusal (navigates to the compare route)", async () => {
    // The two selected runs live on DIFFERENT datasets. The old behaviour refused this
    // at the selection step with a "same dataset" toast; the compare view aligns such
    // runs by shared input, so the selection must now proceed straight to compare.
    const RUN_OTHER_DATASET = {
      ...RUN_OLDER,
      datasetId: "ds2",
      datasetName: "Refunds routing",
      datasetVersionId: "dv2",
    };
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const s = String(url);
      const isRunsList = s.includes("/evaluations/runs") && !/\/evaluations\/runs\/[^/?]+/.test(s);
      return {
        ok: true,
        status: 200,
        json: async () =>
          isRunsList
            ? { data: [RUN, RUN_OTHER_DATASET], meta: { page: 0, limit: 50, total: 2 } }
            : payloadFor(s),
      };
    }) as unknown as typeof fetch;
    mount(<EvaluationsView projectId="p1" />);
    // Select both runs (each on a different dataset).
    fireEvent.click(await screen.findByLabelText("Select run git:4a91c02 #27"));
    fireEvent.click(await screen.findByLabelText("Select run git:0000000 #26"));
    // Open the bulk Actions menu and choose Compare. Radix opens the trigger on
    // pointerdown (not a bare click), so drive it that way.
    fireEvent.pointerDown(await screen.findByRole("button", { name: /Actions \(2 selected\)/ }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText("Compare"));
    // No "same dataset" refusal, and it navigates to the shareable compare route with
    // both ids (in run-number order) and the oldest run seeding the baseline.
    expect(screen.queryByText(/same dataset/i)).toBeNull();
    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith(
        "/projects/p1/evaluations/compare?runs=run0,run1&baseline=run0",
      ),
    );
  });

  it("Run detail renders the per-case results table (no run-identity header)", async () => {
    mount(<RunDetailView projectId="p1" runId="run1" />);
    // The result row is present (the results table shows the case input).
    expect((await screen.findAllByText(/charged twice/)).length).toBeGreaterThan(0);
    // Run identity + switching + comparison all moved to the Evaluations list, so
    // this page carries no header of its own: no candidate badge, no run id, no
    // "Run #" switcher, no inline "Compare with".
    expect(screen.queryByText("git:4a91c02")).toBeNull();
    expect(screen.queryByText("run1")).toBeNull();
    expect(screen.queryByText(/^Run #/)).toBeNull();
    expect(screen.queryByLabelText("Compare with")).toBeNull();
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

// DatasetDetailView is covered in depth by datasets-detail.smoke.test.tsx.
