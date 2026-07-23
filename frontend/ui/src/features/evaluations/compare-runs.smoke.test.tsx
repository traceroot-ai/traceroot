// @vitest-environment jsdom
/**
 * The redesigned comparison page against a fixture reproducing the real
 * ticket-routing lab (Opus baseline → Sonnet candidate): ticket-05 regresses on
 * routing_accuracy + routing_report. Asserts baseline-left orientation, the verdict,
 * the case-vs-scorer-cell distinction, the actual input as the primary label,
 * default sort (ticket-05 first), and the case drawer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("./views/evaluations-view", () => ({
  RunStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: ({ headerIdentity }: { headerIdentity?: { label: string } }) => (
    <div data-testid="trace-panel">{headerIdentity?.label}</div>
  ),
}));
vi.mock("@/features/traces/hooks", () => ({ useTrace: () => ({ data: undefined }) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u", email: "e" } } }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn(async () => ({ spans: [] })) }));
vi.mock("@tanstack/react-query", () => ({
  useQueries: ({ queries }: { queries: unknown[] }) =>
    queries.map(() => ({ data: undefined, isLoading: false, isFetching: false })),
}));

const hooks = vi.hoisted(() => ({
  useEvaluations: vi.fn(),
  useEvaluationRuns: vi.fn(),
  useCompareRuns: vi.fn(),
}));
vi.mock("./hooks", () => hooks);

import { CompareRunsView } from "./views/compare-runs-view";

const runSummary = (id: string, runNumber: number, ver: string, mainScore: number) => ({
  id,
  runNumber,
  evaluationId: "ev1",
  evaluationName: "ticket-routing-quality",
  candidateVersion: ver,
  datasetVersionId: "dv1",
  datasetVersionLabel: "v3",
  status: "completed",
  mainScore,
  mainScoreName: "routing_accuracy",
  caseCount: 7,
  scoredCount: 7,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  startedAt: "2026-07-26T10:00:00.000Z",
  completedAt: "2026-07-26T10:02:00.000Z",
  elapsedMs: 120000,
});

const counts = (p: Record<string, number> = {}) => ({
  improved: 0,
  regressed: 0,
  unchanged: 0,
  changed: 0,
  unpaired: 0,
  not_comparable: 0,
  ...p,
});

const SCORERS = ["routing_accuracy", "routing_report", "is_known_category"];

// One unchanged case (all three scorers 1→1), used to pad to 7.
const unchangedCase = (n: number) => ({
  testCaseId: `ticket-0${n}`,
  input: `Ticket ${n}: my invoice looks wrong`,
  expectedOutput: "billing",
  metadata: null,
  provenance: null,
  inputMatchesDataset: true,
  candidateStatus: "passed",
  baselineStatus: "passed",
  candidateOutput: "billing",
  baselineOutput: "billing",
  candidateTraceId: `t-c-0${n}`,
  baselineTraceId: `t-b-0${n}`,
  candidateCost: 0.01,
  baselineCost: 0.011,
  candidateTaskError: null,
  baselineTaskError: null,
  candidateScores: SCORERS.map((s) => ({
    scorerName: s,
    scorerVersion: "v1",
    numericValue: 1,
    boolValue: null,
    stringValue: null,
    passed: null,
    explanation: "ok",
    error: null,
  })),
  baselineScores: SCORERS.map((s) => ({
    scorerName: s,
    scorerVersion: "v1",
    numericValue: 1,
    boolValue: null,
    stringValue: null,
    passed: null,
    explanation: "ok",
    error: null,
  })),
  outputChanged: false,
  change: "unchanged",
  comparison: {
    caseChange: "unchanged",
    pairing: "paired",
    mainScore: { candidate: 1, baseline: 1, delta: 0 },
    baselineOutput: "billing",
    durationMs: 2100,
    baselineDurationMs: 2000,
    durationDeltaMs: 100,
    baselineTraceId: `t-b-0${n}`,
    scorerCells: SCORERS.map((s) => ({
      scorerName: s,
      scorerVersion: "v1",
      valueType: "numeric",
      direction: "higher_is_better",
      candidateValue: 1,
      baselineValue: 1,
      delta: 0,
      classification: "unchanged",
    })),
    regressedCellCount: 0,
    comparableCellCount: 3,
  },
});

// ticket-05: routing_accuracy 1→0 + routing_report 1→0 regressed, is_known_category unchanged.
const ticket05 = {
  ...unchangedCase(5),
  input: "Ticket 5: my card was double-charged and I want a refund",
  candidateOutput: "account_management",
  baselineOutput: "billing",
  outputChanged: true,
  change: "regressed",
  comparison: {
    caseChange: "regressed",
    pairing: "paired",
    mainScore: { candidate: 0, baseline: 1, delta: -1 },
    baselineOutput: "billing",
    durationMs: 2800,
    baselineDurationMs: 2100,
    durationDeltaMs: 700,
    baselineTraceId: "t-b-05",
    scorerCells: [
      {
        scorerName: "routing_accuracy",
        scorerVersion: "v1",
        valueType: "numeric",
        direction: "higher_is_better",
        candidateValue: 0,
        baselineValue: 1,
        delta: -1,
        classification: "regressed",
      },
      {
        scorerName: "routing_report",
        scorerVersion: "v1",
        valueType: "numeric",
        direction: "higher_is_better",
        candidateValue: 0,
        baselineValue: 1,
        delta: -1,
        classification: "regressed",
      },
      {
        scorerName: "is_known_category",
        scorerVersion: "v1",
        valueType: "numeric",
        direction: "higher_is_better",
        candidateValue: 1,
        baselineValue: 1,
        delta: 0,
        classification: "unchanged",
      },
    ],
    regressedCellCount: 2,
    comparableCellCount: 3,
  },
};

const labData = {
  candidate: runSummary("sonnet", 42, "sonnet", 6 / 7),
  baseline: runSummary("opus", 41, "opus", 1),
  comparison: {
    available: true,
    trustworthy: true,
    reasons: [],
    baseline: { runId: "opus", runNumber: 41, candidateVersion: "opus" },
    mainScore: { candidate: 6 / 7, baseline: 1, delta: 6 / 7 - 1 },
    caseCounts: counts({ regressed: 1, unchanged: 6 }),
    scoreCellCounts: counts({ regressed: 2, unchanged: 19 }),
    scorers: [
      {
        name: "routing_accuracy",
        version: "v1",
        valueType: "numeric",
        direction: "higher_is_better",
        candidateMean: 6 / 7,
        baselineMean: 1,
        delta: 6 / 7 - 1,
        pairedCount: 7,
      },
      {
        name: "routing_report",
        version: "v1",
        valueType: "numeric",
        direction: "higher_is_better",
        candidateMean: 6 / 7,
        baselineMean: 1,
        delta: 6 / 7 - 1,
        pairedCount: 7,
      },
      {
        name: "is_known_category",
        version: "v1",
        valueType: "numeric",
        direction: "higher_is_better",
        candidateMean: 1,
        baselineMean: 1,
        delta: 0,
        pairedCount: 7,
      },
    ],
    duration: { candidateMeanMs: 2300, baselineMeanMs: 2050, deltaMs: 250, pairedCount: 7 },
  },
  results: [
    unchangedCase(1),
    unchangedCase(2),
    unchangedCase(3),
    unchangedCase(4),
    ticket05,
    unchangedCase(6),
    unchangedCase(7),
  ],
};

beforeEach(() => {
  hooks.useEvaluations.mockReturnValue({
    data: { data: [{ id: "ev1", name: "ticket-routing-quality" }] },
  });
  hooks.useEvaluationRuns.mockReturnValue({ data: { data: [] } });
  hooks.useCompareRuns.mockReturnValue({ isLoading: false, error: null, data: labData });
});
afterEach(() => cleanup());

const mount = () =>
  render(
    <CompareRunsView projectId="p1" candidateId="sonnet" baselineId="opus" onChange={vi.fn()} />,
  );

describe("CompareRunsView — Opus → Sonnet lab", () => {
  it("reads Baseline (opus) → Candidate (sonnet) in that order", () => {
    mount();
    const labels = screen.getAllByText(/^(Baseline|Candidate)$/).map((el) => el.textContent);
    expect(labels[0]).toBe("Baseline");
    expect(labels[1]).toBe("Candidate");
    expect(screen.getByText("Run #41")).toBeTruthy(); // baseline
    expect(screen.getByText("Run #42")).toBeTruthy(); // candidate
  });

  it("verdict is a Regression with transparent reasons", () => {
    mount();
    expect(screen.getByText("Regression")).toBeTruthy();
    expect(screen.getByText(/1 of 7 test cases regressed/)).toBeTruthy();
    expect(screen.getByText(/2 scorer values regressed/)).toBeTruthy();
  });

  it("separates regressed test cases (1) from regressed scorer cells (2)", () => {
    mount();
    expect(screen.getByText("Regressed test cases")).toBeTruthy();
    // The per-scorer summary names the two affected scorers.
    expect(screen.getAllByText("routing_accuracy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("routing_report").length).toBeGreaterThan(0);
  });

  it("shows the actual ticket input as the primary label, id secondary; ticket-05 sorted first", () => {
    mount();
    expect(screen.getByText(/double-charged and I want a refund/)).toBeTruthy();
    // Default sort puts the regression first: within the CASE table (the one with the
    // "Input" header), the first body row's input is ticket-05's.
    const caseTable = screen.getByText("Input").closest("table") as HTMLTableElement;
    const bodyRows = within(caseTable).getAllByRole("row").slice(1); // drop header row
    expect(within(bodyRows[0]).getByText(/double-charged/)).toBeTruthy();
  });

  it("opens a case drawer with baseline/candidate outputs and per-scorer breakdown", () => {
    mount();
    fireEvent.click(screen.getByText(/double-charged and I want a refund/));
    expect(screen.getByText("Case comparison")).toBeTruthy();
    // Baseline output "billing" and candidate output "account_management" are shown.
    expect(screen.getAllByText(/account_management/).length).toBeGreaterThan(0);
    // Trace access buttons.
    expect(screen.getByRole("button", { name: /Open candidate trace/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open baseline trace/ })).toBeTruthy();
  });

  it("switches to a trace panel without leaving the page", () => {
    mount();
    fireEvent.click(screen.getByText(/double-charged and I want a refund/));
    fireEvent.click(screen.getByRole("button", { name: /Open candidate trace/ }));
    expect(screen.getByTestId("trace-panel").textContent).toBe("Candidate trace");
    expect(screen.getByText("Case comparison")).toBeTruthy(); // drawer still mounted
  });

  it("does not label a same-evaluation pair as cross-evaluation", () => {
    mount();
    expect(screen.queryByText("Cross-evaluation comparison")).toBeNull();
  });
});
