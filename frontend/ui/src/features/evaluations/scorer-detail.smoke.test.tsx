// @vitest-environment jsdom
/**
 * The read-only, detector-style Scorer detail: Name, Model (LLM judge only),
 * Prompt or code snippet, and Pass threshold. Everything renders read-only, and
 * fields the SDK didn't report show a plain em dash.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

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
    requiredInputs: null,
    metadata: null,
    model: null,
    messages: null,
    language: null,
    sourceCode: null,
    ...p,
  };
}

const mount = (scorer: ScorerRegistryRow) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ScorerDetailPanel scorer={scorer} onClose={() => {}} />
    </QueryClientProvider>,
  );

afterEach(() => cleanup());

describe("ScorerDetailPanel", () => {
  it("LLM judge — Name, Model, Prompt, Pass threshold", () => {
    mount(
      row({
        name: "concise",
        scorerType: "llm_judge",
        threshold: 0.8,
        model: "claude-sonnet-5",
        messages: [
          { role: "system", content: "Rate the answer conciseness from 0 to 1." },
          { role: "user", content: "ANSWER placeholder" },
        ],
      }),
    );
    const detail = screen.getByLabelText("Scorer detail");
    // The four detector-style cards.
    expect(within(detail).getByText("Name")).toBeDefined();
    expect(within(detail).getByText("Model")).toBeDefined();
    expect(within(detail).getByText("Prompt")).toBeDefined();
    expect(within(detail).getByText("Pass threshold")).toBeDefined();
    // Their values — model in the read-only dropdown, only the system prompt shown.
    expect(within(detail).getByText("claude-sonnet-5")).toBeDefined();
    expect(detail.textContent).toContain("Rate the answer conciseness");
    expect(detail.textContent).toContain("0.8");
    // Removed sections are gone.
    expect(within(detail).queryByText("Configuration")).toBeNull();
    expect(within(detail).queryByText("Observed usage")).toBeNull();
    expect(within(detail).queryByText("Code")).toBeNull();
  });

  it("Code snippet — Name, Code, Pass threshold (no Model)", () => {
    mount(
      row({
        name: "exact_match",
        version: "unversioned",
        scorerType: "code",
        language: "python",
        threshold: 1,
        sourceCode: "def exact_match(ctx):\n    return 1.0 if ctx.output == ctx.expected else 0.0",
      }),
    );
    const detail = screen.getByLabelText("Scorer detail");
    expect(within(detail).getByText("Code")).toBeDefined();
    expect(detail.textContent).toContain("def exact_match"); // source (tokenized)
    expect(within(detail).getByText("Pass threshold")).toBeDefined();
    // A code scorer runs no model.
    expect(within(detail).queryByText("Model")).toBeNull();
    expect(within(detail).queryByText("Prompt")).toBeNull();
  });

  it("No definition reported — em-dash fallbacks, no observed-usage block", () => {
    mount(row({ name: "routing_accuracy", declaredValueType: null, threshold: null }));
    const detail = screen.getByLabelText("Scorer detail");
    // Still shows the Name and Pass threshold cards, honestly empty.
    expect(within(detail).getByText("Name")).toBeDefined();
    expect(within(detail).getByText("Pass threshold")).toBeDefined();
    expect(detail.textContent).toContain("—");
    // No observed-usage/analytics block on the read-only detail.
    expect(within(detail).queryByText("Observed usage")).toBeNull();
  });

  it("Requires — reference answer USED when the scorer reads `expected`", () => {
    mount(row({ name: "exact_match", requiredInputs: ["input", "output", "expected"] }));
    const detail = screen.getByLabelText("Scorer detail");
    expect(within(detail).getByText("Requires")).toBeDefined();
    // The declared inputs are shown, and the reference-answer line reads "used".
    expect(within(detail).getByText("expected")).toBeDefined();
    expect(detail.textContent).toContain("used by this scorer");
    expect(detail.textContent).not.toContain("not required by this scorer");
  });

  it("Requires — reference answer NOT required (a reference-free judge)", () => {
    mount(row({ name: "conciseness", requiredInputs: ["input", "output"] }));
    const detail = screen.getByLabelText("Scorer detail");
    // A case with no expected output can tell this is deliberate, not a gap.
    expect(detail.textContent).toContain("not required by this scorer");
  });

  it("Requires — em dash when the SDK never declared the inputs (unknown, not 'nothing')", () => {
    mount(row({ name: "routing_accuracy", requiredInputs: null }));
    const detail = screen.getByLabelText("Scorer detail");
    const requires = within(detail).getByText("Requires").parentElement;
    expect(requires?.textContent).toContain("—");
    expect(requires?.textContent).not.toContain("Reference answer");
  });
});
