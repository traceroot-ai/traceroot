// @vitest-environment jsdom
/**
 * The read-only, detector-style Scorer detail (task #5). Asserts the two scorer types —
 * LLM judge (model + messages) and code snippet (source + language) — plus the shared
 * config/metadata block, and honest "Not provided by SDK" fallbacks when the SDK reports
 * no definition. Data contract: offline-eval/sdk-ask/scorer-definition-reporting.md.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// ScorerDetailPanel calls useScorer (version history) only; stub it.
vi.mock("./hooks", () => ({ useScorer: () => ({ data: { versions: [] } }) }));

import { ScorerDetailPanel } from "./views/evaluations-view";
import type { ScorerRegistryRow } from "./hooks";

function row(p: Partial<ScorerRegistryRow>): ScorerRegistryRow {
  return {
    name: "s",
    version: "1",
    scoreCount: 10,
    errorCount: 0,
    errorRate: 0,
    valueType: "numeric",
    declaredValueType: "numeric",
    direction: "higher_is_better",
    threshold: 0.8,
    numeric: { mean: 0.9, min: 0, max: 1, count: 10 },
    passRate: null,
    distribution: null,
    runCount: 2,
    evaluationCount: 1,
    lastUsed: null,
    recentErrors: [],
    source: "SDK",
    scorerType: null,
    outputType: null,
    description: null,
    metadata: null,
    model: null,
    messages: null,
    language: null,
    sourceCode: null,
    ...p,
  };
}

const mount = (scorer: ScorerRegistryRow) =>
  render(<ScorerDetailPanel projectId="p1" scorer={scorer} onClose={() => {}} />);

afterEach(() => cleanup());

describe("ScorerDetailPanel", () => {
  it("LLM judge — shows model + messages + shared config", () => {
    mount(
      row({
        name: "concise",
        scorerType: "llm_judge",
        outputType: "score",
        threshold: 0.8,
        description: "Judges answer conciseness",
        metadata: { team: "quality" },
        model: "claude-sonnet-5",
        messages: [
          { role: "system", content: "Rate the answer conciseness from 0 to 1." },
          { role: "user", content: "ANSWER placeholder" },
        ],
      }),
    );
    const detail = screen.getByLabelText("Scorer detail");
    expect(within(detail).getByText("LLM judge")).toBeDefined(); // header type badge
    expect(within(detail).getByText("Model")).toBeDefined();
    expect(within(detail).getByText("claude-sonnet-5")).toBeDefined();
    expect(within(detail).getByText("Messages")).toBeDefined();
    expect(within(detail).getByText("system")).toBeDefined();
    expect(within(detail).getByText(/Rate the answer conciseness/)).toBeDefined();
    // Shared config block.
    expect(within(detail).getByText("Score")).toBeDefined(); // output type
    expect(within(detail).getByText("Judges answer conciseness")).toBeDefined();
    expect(detail.textContent).toContain("quality"); // metadata json
    // Not a code scorer.
    expect(within(detail).queryByText(/^Code/)).toBeNull();
  });

  it("Code snippet — shows source + language + shared config", () => {
    mount(
      row({
        name: "exact_match",
        version: "unversioned",
        scorerType: "code",
        outputType: "classification",
        language: "python",
        threshold: 1,
        description: "Exact string match",
        sourceCode: "def exact_match(ctx):\n    return 1.0 if ctx.output == ctx.expected else 0.0",
      }),
    );
    const detail = screen.getByLabelText("Scorer detail");
    expect(within(detail).getByText("Code")).toBeDefined(); // header type badge
    expect(within(detail).getByText("Code · Python")).toBeDefined(); // card title
    expect(detail.textContent).toContain("def exact_match"); // source (tokenized)
    expect(within(detail).getByText("Classification")).toBeDefined(); // output type
    expect(within(detail).queryByText("Model")).toBeNull();
  });

  it("No definition reported — honest 'Not provided by SDK' fallbacks", () => {
    mount(row({ name: "routing_accuracy", declaredValueType: null, threshold: null }));
    const detail = screen.getByLabelText("Scorer detail");
    // No type badge for an undeclared scorer.
    expect(within(detail).queryByText("LLM judge")).toBeNull();
    expect(within(detail).queryByText("Code")).toBeNull();
    expect(within(detail).getAllByText("Not provided by SDK").length).toBeGreaterThan(0);
    // Observed usage is still shown honestly.
    expect(within(detail).getByText("Observed usage")).toBeDefined();
  });
});
