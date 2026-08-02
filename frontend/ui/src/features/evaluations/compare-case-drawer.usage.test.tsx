// @vitest-environment jsdom
/**
 * The case drawer's operational block must keep the candidate's task cost SEPARATE
 * from the evaluation judge's overhead, and report the models it actually OBSERVED
 * in each side's trace (never inferred from a candidate label). This mounts the
 * drawer over a candidate trace that has an LLM judge and a baseline trace that has
 * none, then asserts the three rows read correctly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { CompareResultRow, CompareRunSummary } from "./types";

// Per-trace spans: candidate has a judge subtree (SCORER→LLM), baseline does not.
const TRACES: Record<string, unknown[]> = {
  tr_cand: [
    { span_id: "r", parent_span_id: null, span_kind: "EVALUATION" },
    { span_id: "t", parent_span_id: "r", span_kind: "TASK" },
    {
      span_id: "t-llm",
      parent_span_id: "t",
      span_kind: "LLM",
      total_tokens: 120,
      cost: 0.003,
      model_name: "claude-sonnet-4",
    },
    { span_id: "s", parent_span_id: "r", span_kind: "SCORER" },
    {
      span_id: "j-llm",
      parent_span_id: "s",
      span_kind: "LLM",
      total_tokens: 45,
      cost: 0.001,
      model_name: "gpt-4o-judge",
    },
  ],
  tr_base: [
    { span_id: "r", parent_span_id: null, span_kind: "EVALUATION" },
    { span_id: "t", parent_span_id: "r", span_kind: "TASK" },
    {
      span_id: "t-llm",
      parent_span_id: "t",
      span_kind: "LLM",
      total_tokens: 100,
      cost: 0.002,
      model_name: "claude-opus-4",
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
  TraceIODiffSection: () => <div data-testid="io-diff" />,
}));

import { CompareCaseDrawer } from "./views/compare-case-drawer";

const ROW = {
  testCaseId: "case-1",
  input: "Produce a report about Q2 performance",
  expectedOutput: null,
  candidateOutput: "Q2 grew 12%.",
  baselineOutput: "Q2 grew 10%.",
  candidateTraceId: "tr_cand",
  baselineTraceId: "tr_base",
  candidateCost: 0.004,
  baselineCost: 0.002,
  candidateTaskError: null,
  baselineTaskError: null,
  candidateScores: [],
  baselineScores: [],
  outputChanged: true,
  inputMatchesDataset: true,
  provenance: null,
  comparison: { scorerCells: [], baselineDurationMs: 2100, durationMs: 2400 },
} as unknown as CompareResultRow;

const RUN = (n: number, ver: string): CompareRunSummary =>
  ({ runNumber: n, candidateVersion: ver }) as unknown as CompareRunSummary;

function rowText(label: string): string {
  return screen.getByText(label).parentElement?.textContent ?? "";
}

afterEach(() => cleanup());

describe("CompareCaseDrawer — task vs judge overhead and observed models", () => {
  it("keeps candidate tokens separate from evaluation overhead and shows observed models", () => {
    render(
      <CompareCaseDrawer
        projectId="p1"
        row={ROW}
        candidate={RUN(2, "sonnet")}
        baseline={RUN(1, "opus")}
        onClose={() => {}}
      />,
    );

    // Candidate task tokens: baseline 100 → candidate 120 (the judge's 45 is NOT here).
    expect(rowText("Candidate tokens")).toMatch(/100.*→.*120/);

    // The judge's own tokens are reported apart, and never folded into the candidate:
    // baseline had no judge (None), candidate's judge spent 45.
    expect(rowText("Evaluation overhead")).toMatch(/None.*→.*45/);
    expect(rowText("Evaluation overhead")).toMatch(/judge tokens/);

    // Observed models are measured per side from the trace, not the "opus"/"sonnet"
    // candidate labels.
    expect(rowText("Observed model")).toMatch(/claude-opus-4.*→.*claude-sonnet-4/);
  });
});
