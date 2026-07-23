// @vitest-environment jsdom
/**
 * The Compare tab: pick an evaluation + two runs, see the candidate-vs-baseline
 * summary and per-case table. Mounts against stubbed hooks (no network) and
 * asserts the summary deltas + case rows render, and that the two run pickers
 * default to the two newest runs.
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
// RunStatusBadge is imported from the sibling view; stub it to avoid pulling the
// whole evaluations view (and its own hook graph) into this mount.
vi.mock("./views/evaluations-view", () => ({
  RunStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

import { CompareTab } from "./views/compare-runs-view";

const run = (id: string, runNumber: number) => ({
  id,
  runNumber,
  candidateVersion: `git:${id}`,
});

const summary = (id: string, runNumber: number, mainScore: number) => ({
  id,
  runNumber,
  evaluationId: "ev1",
  evaluationName: "Billing routing",
  candidateVersion: `git:${id}`,
  datasetVersionId: "dv1",
  datasetVersionLabel: "v3",
  status: "completed",
  mainScore,
  mainScoreName: "Routing accuracy",
  caseCount: 2,
  scoredCount: 2,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  startedAt: "2026-07-24T10:00:00.000Z",
  completedAt: "2026-07-24T10:01:00.000Z",
  elapsedMs: 60000,
});

beforeEach(() => {
  hooks.useEvaluations.mockReturnValue({
    data: { data: [{ id: "ev1", name: "Billing routing" }] },
  });
  hooks.useEvaluationRuns.mockReturnValue({ data: { data: [run("b", 7), run("a", 5)] } });
  hooks.useCompareRuns.mockReturnValue({
    isLoading: false,
    error: null,
    data: {
      candidate: summary("b", 7, 0.95),
      baseline: summary("a", 5, 0.9),
      comparison: {
        available: true,
        trustworthy: true,
        reasons: [],
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
      },
      results: [
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
      ],
    },
  });
});
afterEach(() => cleanup());

describe("CompareTab", () => {
  it("renders the A-vs-B summary and the per-case row", () => {
    render(<CompareTab projectId="p1" />);

    // Both run headers.
    expect(screen.getByText("Run #7")).toBeTruthy();
    expect(screen.getByText("Run #5")).toBeTruthy();
    // Case-count summary + the improved case.
    expect(screen.getByText(/1 improved/)).toBeTruthy();
    expect(screen.getByText("case-1")).toBeTruthy();
  });

  it("defaults the pickers to the two newest runs", () => {
    render(<CompareTab projectId="p1" />);
    const call = hooks.useCompareRuns.mock.calls.at(-1);
    // (projectId, candidateId, baselineId) → newest = 7 (id "b"), next = 5 (id "a").
    expect(call?.[1]).toBe("b");
    expect(call?.[2]).toBe("a");
  });
});
