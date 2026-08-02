// @vitest-environment jsdom
/**
 * Offline-eval acceptance scenario — the canonical shape the workflow-completion pass
 * targets, exercised end to end across the surfaces it touches:
 *
 *   ONE shared test case — "Produce a report about Q2 performance" —
 *   run by an Opus BASELINE (passes) and a Sonnet CANDIDATE (fails),
 *   producing ONE row with TWO candidate outputs, judged by a scorer that needs
 *   no reference answer (so the missing "expected" reads "not required", not a gap).
 *
 * This asserts the product mental model holds together: the candidate identity is the
 * model (declared + observed, opus vs sonnet), the test case is a stable input that
 * never "uses" a model, and automated pass/fail is per candidate — never the case.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompareResultRow, CompareRunSummary } from "./types";
import type { ScorerRegistryRow } from "./hooks";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// Per-side traces: the baseline ran Opus, the candidate ran Sonnet — observed from
// the trace, not inferred from the "opus"/"sonnet" run labels.
const TRACES: Record<string, unknown[]> = {
  tr_base: [
    { span_id: "r", parent_span_id: null, span_kind: "EVALUATION" },
    { span_id: "t", parent_span_id: "r", span_kind: "TASK" },
    {
      span_id: "l",
      parent_span_id: "t",
      span_kind: "LLM",
      total_tokens: 900,
      cost: 0.02,
      model_name: "claude-opus-4",
    },
  ],
  tr_cand: [
    { span_id: "r", parent_span_id: null, span_kind: "EVALUATION" },
    { span_id: "t", parent_span_id: "r", span_kind: "TASK" },
    {
      span_id: "l",
      parent_span_id: "t",
      span_kind: "LLM",
      total_tokens: 620,
      cost: 0.006,
      model_name: "claude-sonnet-4",
    },
  ],
};

vi.mock("@/features/traces/hooks", () => ({
  useTrace: (_p: string, traceId: string) => ({
    data: TRACES[traceId] ? { spans: TRACES[traceId] } : undefined,
  }),
}));
vi.mock("@/features/traces/components/TraceIOValue", () => ({
  TraceIOSection: ({ title, content }: { title: string; content?: string }) => (
    <div>
      {title}: {content}
    </div>
  ),
}));
vi.mock("@/features/traces/components/TraceIODiff", () => ({
  TraceIODiffSection: ({ baseline, candidate }: { baseline?: string; candidate?: string }) => (
    <div>
      <div data-testid="baseline-output">{baseline}</div>
      <div data-testid="candidate-output">{candidate}</div>
    </div>
  ),
}));

import { CompareCaseDrawer } from "./views/compare-case-drawer";
import { ScorerDetailPanel } from "./views/evaluations-view";

const SHARED_INPUT = "Produce a report about Q2 performance";

// One row, one shared test case, two candidate outputs. Baseline (Opus) passed the
// main scorer, candidate (Sonnet) failed it — a regression on this case.
const ROW = {
  testCaseId: "q2-report",
  input: SHARED_INPUT,
  expectedOutput: null, // no reference answer — see the scorer below
  baselineOutput: "Q2 revenue rose 12% QoQ; margin held at 41%. …full report…",
  candidateOutput: "I can't produce that report.",
  candidateTraceId: "tr_cand",
  baselineTraceId: "tr_base",
  candidateCost: 0.006,
  baselineCost: 0.02,
  candidateStatus: "failed",
  baselineStatus: "passed",
  candidateTaskError: null,
  baselineTaskError: null,
  candidateScores: [],
  baselineScores: [],
  outputChanged: true,
  inputMatchesDataset: true,
  provenance: null,
  comparison: {
    baselineDurationMs: 5200,
    durationMs: 1800,
    scorerCells: [
      {
        scorerName: "report_quality",
        scorerVersion: "v1",
        valueType: "boolean",
        direction: "higher_is_better",
        baselineValue: true, // Pass
        candidateValue: false, // Fail
        delta: null,
        classification: "regressed",
      },
    ],
  },
} as unknown as CompareResultRow;

const CANDIDATE = {
  runNumber: 2,
  candidateVersion: "sonnet",
  declaredModel: "claude-sonnet-4",
} as unknown as CompareRunSummary;
const BASELINE = {
  runNumber: 1,
  candidateVersion: "opus",
  declaredModel: "claude-opus-4",
} as unknown as CompareRunSummary;

// The main scorer grades the report directly — it reads input + output, but NOT a
// reference answer, so the case's missing `expected` is by design.
function reportScorer(p: Partial<ScorerRegistryRow> = {}): ScorerRegistryRow {
  return {
    name: "report_quality",
    version: "v1",
    scoreCount: 2,
    errorCount: 0,
    errorRate: 0,
    valueType: "boolean",
    declaredValueType: "boolean",
    direction: "higher_is_better",
    threshold: 0.5,
    numeric: null,
    passRate: 0.5,
    distribution: null,
    runCount: 2,
    evaluationCount: 1,
    lastUsed: null,
    recentErrors: [],
    source: "SDK",
    scorerType: "llm_judge",
    outputType: "classification",
    description: "Judges whether the report is accurate and complete.",
    requiredInputs: ["input", "output"],
    metadata: null,
    model: "claude-sonnet-4",
    messages: null,
    language: null,
    sourceCode: null,
    ...p,
  };
}

afterEach(() => cleanup());

describe("offline-eval acceptance — one case, Opus(Pass) → Sonnet(Fail)", () => {
  it("shows the shared test case, both candidate outputs, and each side's model", () => {
    render(
      <CompareCaseDrawer
        projectId="p1"
        row={ROW}
        candidate={CANDIDATE}
        baseline={BASELINE}
        onClose={() => {}}
      />,
    );

    // ONE shared test case (a stable input) — the identity of the row.
    expect(screen.getByText("q2-report")).toBeDefined();
    expect(screen.getByText(new RegExp(SHARED_INPUT))).toBeDefined();

    // TWO candidate outputs for that one case: the Opus baseline's and the Sonnet
    // candidate's, side by side.
    expect(screen.getByTestId("baseline-output").textContent).toContain("Q2 revenue rose 12%");
    expect(screen.getByTestId("candidate-output").textContent).toContain("I can't produce that");

    // The main scorer's per-candidate verdict: baseline Pass, candidate Fail — attached
    // to the candidate, never to the test case.
    expect(screen.getByText("Pass")).toBeDefined();
    expect(screen.getByText("Fail")).toBeDefined();

    // Observed models: the baseline ran Opus, the candidate ran Sonnet.
    const observed = screen.getByText("Observed model").parentElement?.textContent ?? "";
    expect(observed).toMatch(/claude-opus-4.*→.*claude-sonnet-4/);

    // Baseline → Candidate orientation in the footer.
    expect(screen.getByText(/Baseline Run #1/)).toBeDefined();
    expect(screen.getByText(/Candidate Run #2/)).toBeDefined();
  });

  it("marks the missing reference answer 'not required by this scorer', not a gap", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ScorerDetailPanel scorer={reportScorer()} onClose={() => {}} />
      </QueryClientProvider>,
    );
    const detail = screen.getByLabelText("Scorer detail");
    expect(within(detail).getByText("Requires")).toBeDefined();
    // The case carried no expected output — and that is correct here, because the
    // scorer never asks for one.
    expect(detail.textContent).toContain("not required by this scorer");
  });
});
