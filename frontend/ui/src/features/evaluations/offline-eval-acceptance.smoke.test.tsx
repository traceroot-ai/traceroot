// @vitest-environment jsdom
/**
 * Offline-eval scorer acceptance — a scorer that grades the output directly reads
 * input + output but NOT a reference answer, so a case with no `expected` reads
 * "not required by this scorer", never a missing-data gap. Part of the product mental
 * model: automated pass/fail is a property of the candidate + scorer, and a scorer
 * declares what inputs it needs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ScorerRegistryRow } from "./hooks";

import { ScorerDetailPanel } from "./views/evaluations-view";

afterEach(() => cleanup());

// The main scorer grades the report directly — it reads input + output, but NOT a
// reference answer, so a case's missing `expected` is by design.
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

describe("offline-eval scorer acceptance — a scorer that needs no reference answer", () => {
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
