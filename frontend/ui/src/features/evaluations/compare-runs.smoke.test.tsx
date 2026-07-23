// @vitest-environment jsdom
/**
 * The shareable Compare view (URL-driven baseline/candidate): renders the A-vs-B
 * summary + per-case table, and labels a cross-evaluation pair. Mounts against
 * stubbed hooks (no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const hooks = vi.hoisted(() => ({
  useEvaluations: vi.fn(),
  useEvaluationRuns: vi.fn(),
  useCompareRuns: vi.fn(),
}));
vi.mock("./hooks", () => hooks);
vi.mock("./views/evaluations-view", () => ({
  RunStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

import { CompareRunsView } from "./views/compare-runs-view";

const summary = (id: string, runNumber: number, evaluationId: string, evaluationName: string) => ({
  id,
  runNumber,
  evaluationId,
  evaluationName,
  candidateVersion: `git:${id}`,
  datasetVersionId: "dv1",
  datasetVersionLabel: "v3",
  status: "completed",
  mainScore: 0.9,
  mainScoreName: "Routing accuracy",
  caseCount: 2,
  scoredCount: 2,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  startedAt: "2026-07-25T10:00:00.000Z",
  completedAt: "2026-07-25T10:01:00.000Z",
  elapsedMs: 60000,
});

const comparison = (reasons: string[]) => ({
  available: true,
  trustworthy: reasons.length === 0,
  reasons,
  baseline: { runId: "a", runNumber: 5, candidateVersion: "git:a" },
  mainScore: { candidate: 0.95, baseline: 0.9, delta: 0.05 },
  caseCounts: {
    improved: 1,
    regressed: 0,
    unchanged: 1,
    changed: 0,
    unpaired: 0,
    not_comparable: 0,
  },
  scoreCellCounts: {
    improved: 1,
    regressed: 0,
    unchanged: 1,
    changed: 0,
    unpaired: 0,
    not_comparable: 0,
  },
  scorers: [],
  duration: { candidateMeanMs: 1200, baselineMeanMs: 1500, deltaMs: -300, pairedCount: 2 },
});

const results = [
  {
    testCaseId: "case-1",
    status: "passed",
    traceId: "tr1",
    candidateOutput: "billing",
    change: "improved",
    comparison: {
      caseChange: "improved",
      pairing: "paired",
      mainScore: { candidate: 1, baseline: 0.5, delta: 0.5 },
      baselineOutput: "tech",
      baselineDurationMs: 1500,
      durationDeltaMs: -300,
      baselineTraceId: "trB",
      scorerCells: [],
      regressedCellCount: 0,
      comparableCellCount: 1,
    },
  },
];

beforeEach(() => {
  hooks.useEvaluations.mockReturnValue({
    data: { data: [{ id: "ev1", name: "Billing routing" }] },
  });
  hooks.useEvaluationRuns.mockReturnValue({ data: { data: [] } });
});
afterEach(() => cleanup());

describe("CompareRunsView", () => {
  it("renders the A-vs-B summary and per-case row for a same-evaluation pair", () => {
    hooks.useCompareRuns.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        candidate: summary("b", 7, "ev1", "Billing routing"),
        baseline: summary("a", 5, "ev1", "Billing routing"),
        comparison: comparison([]),
        results,
      },
    });
    render(<CompareRunsView projectId="p1" candidateId="b" baselineId="a" onChange={vi.fn()} />);
    expect(screen.getByText("Run #7")).toBeTruthy();
    expect(screen.getByText("Run #5")).toBeTruthy();
    expect(screen.getByText(/1 improved/)).toBeTruthy();
    expect(screen.getByText("case-1")).toBeTruthy();
    expect(screen.queryByText("Cross-evaluation comparison")).toBeNull();
  });

  it("labels a cross-evaluation pair", () => {
    hooks.useCompareRuns.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        candidate: summary("b", 7, "ev2", "Refund handling"),
        baseline: summary("a", 5, "ev1", "Billing routing"),
        comparison: comparison(["different_evaluation"]),
        results,
      },
    });
    render(<CompareRunsView projectId="p1" candidateId="b" baselineId="a" onChange={vi.fn()} />);
    expect(screen.getByText("Cross-evaluation comparison")).toBeTruthy();
  });

  it("shows the precise reason when a comparison is incompatible", () => {
    hooks.useCompareRuns.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        candidate: summary("b", 7, "ev1", "Billing routing"),
        baseline: summary("a", 5, "ev1", "Billing routing"),
        comparison: comparison(["different_dataset_version"]),
        results,
      },
    });
    render(<CompareRunsView projectId="p1" candidateId="b" baselineId="a" onChange={vi.fn()} />);
    expect(screen.getByText(/different immutable dataset versions/)).toBeTruthy();
  });
});
