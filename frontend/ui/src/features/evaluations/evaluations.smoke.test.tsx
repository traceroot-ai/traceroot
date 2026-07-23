// @vitest-environment jsdom
/**
 * View-mount ("e2e") smoke for the real, server-backed Datasets + Evaluations
 * pages (Phase 8). The routes sit behind auth and can't be driven over HTTP
 * without a session, and the repo has no browser driver — so mounting the views
 * against a stubbed fetch (server-shaped payloads) is how the browser path is
 * checked, exactly like offline-eval.smoke.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
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
  mainScore: 93.8,
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
  changeFromBaseline: 22.4,
  errorCount: 2,
  baselineComparable: true,
  elapsedMs: 360000,
  comparison: {
    available: true,
    trustworthy: true,
    reasons: [],
    baseline: { runId: "run0", runNumber: 26, candidateVersion: "git:0000000" },
    mainScore: { candidate: 93.8, baseline: 71.4, delta: 22.4 },
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

function payloadFor(url: string): unknown {
  if (url.includes("/evaluations/runs/run1")) return { run: RUN, results: [RESULT] };
  if (url.includes("/evaluations/runs"))
    return { data: [RUN], meta: { page: 0, limit: 50, total: 1 } };
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
            mainScore: 93.8,
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

  it("Evaluations shows a detectors-style empty page with a Run evaluation CTA", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    })) as unknown as typeof fetch;
    mount(<EvaluationsView projectId="p1" />);
    expect(await screen.findByText(/No evaluation runs yet/)).toBeDefined();
    expect((await screen.findAllByText("Run evaluation")).length).toBeGreaterThan(0);
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
