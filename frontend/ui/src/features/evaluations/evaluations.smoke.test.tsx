// @vitest-environment jsdom
/**
 * View-mount ("e2e") smoke for the real, server-backed Datasets + Evaluations
 * pages (Phase 8). The routes sit behind auth and can't be driven over HTTP
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
};

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
      currentVersion: {
        id: "dv1",
        datasetId: "ds1",
        projectId: "p1",
        versionNumber: 1,
        label: "v1",
        note: null,
        createdBy: null,
        createTime: "2026-07-16T00:00:00Z",
      },
      testCases: [],
      versions: [
        {
          id: "dv1",
          datasetId: "ds1",
          projectId: "p1",
          versionNumber: 1,
          label: "v1",
          note: null,
          createdBy: null,
          createTime: "2026-07-16T00:00:00Z",
        },
      ],
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
  // the faithful views use toasts, so the harness mirrors that wrapping.
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
    expect(await screen.findByText(/Run #27 ·/)).toBeDefined();
    expect(await screen.findByText(/Run #26 ·/)).toBeDefined();
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
    await screen.findByText(/Run #27 ·/);
    fireEvent.click(screen.getByRole("button", { name: /Group by evaluation/ }));
    // Group header shows per-column aggregate totals across the lineage (not the latest
    // run's values): run count, the averaged main score, and total captions.
    expect(await screen.findByText(/2 runs/)).toBeDefined();
    expect(screen.getByText(/93\.8%/)).toBeDefined(); // avg main score across the lineage
    expect(screen.getAllByText("total").length).toBeGreaterThan(0);
  });

  it("selecting exactly two runs offers a Compare action", async () => {
    mount(<EvaluationsView projectId="p1" />);
    await screen.findByText(/Run #27 ·/);
    // Only the per-row checkboxes (labels like "Select … #27"), not the select-all header.
    const boxes = screen
      .getAllByRole("checkbox")
      .filter((b) => /^Select .*#\d/.test(b.getAttribute("aria-label") ?? ""));
    expect(boxes.length).toBe(2);
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(await screen.findByRole("button", { name: /Compare/ })).toBeDefined();
  });

  it("Scorers tab shows an SDK-defined scorer and its detail is honest about gaps", async () => {
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Scorers/ }));
    // Clicking a scorer row opens the detail panel; then assert on it.
    fireEvent.click(await screen.findByText("routing-accuracy"));
    expect(await screen.findByText("Defined in SDK")).toBeDefined();
    const detail = screen.getByLabelText("Scorer detail");
    // This fixture reports no definition (no type/model/source), so the detector-style
    // detail is honest about the gaps but still shows the observed usage + config cards.
    expect(within(detail).getAllByText("Not provided by SDK").length).toBeGreaterThan(0);
    expect(within(detail).getByText("Configuration")).toBeDefined();
    expect(within(detail).getByText("Observed usage")).toBeDefined();
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
