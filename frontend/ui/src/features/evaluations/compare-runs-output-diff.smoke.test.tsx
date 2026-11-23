// @vitest-environment jsdom
/**
 * A candidate's output marks the words that changed against a reference the viewer picks
 * in the Display menu: the baseline's output (the default), the expected output, or none.
 * The baseline's own line is never marked. Marking leaves the output's text as it is, so a
 * search, a copy or a selection reads it unchanged, and clipped text keeps the marks inside
 * what it shows. The choice is kept per viewer, with the rest of the layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fixtureResult, fixtureRun, fixtureScore } from "./compare/__tests__/paired-fixture";
import { caseGroup, cellAt } from "./compare/__tests__/table-grid";
import type { RunBundle } from "./compare/model";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
vi.mock("./hooks", () => hooks);

import { CompareRunsView } from "./views/compare-runs-view";

const EXPECTED = "Refunds are available within 30 days.";
const answer = (runId: string, candidateOutput: string) =>
  fixtureResult(runId, "case-1", "Explain the refund window.", [fixtureScore("quality", 0.9)], {
    expectedOutput: EXPECTED,
    candidateOutput,
  });
const RUNS: RunBundle[] = [
  {
    run: fixtureRun("a", 1, "baseline-v1", "2026-11-01T00:00:00Z"),
    results: [answer("a", "Refunds are available within 14 days.")],
  },
  {
    run: fixtureRun("b", 2, "candidate-v2", "2026-11-02T00:00:00Z"),
    results: [answer("b", "Refunds are available within 30 business days.")],
  },
];
const STORAGE_KEY = "traceroot:compare-display:p1";

beforeEach(() => {
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: RUNS.find((b) => b.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const mount = () =>
  render(
    <CompareRunsView
      projectId="p1"
      runIds={["a", "b"]}
      baselineId="a"
      onChangeBaseline={vi.fn()}
      onChangeRuns={vi.fn()}
      inspected={null}
      onInspect={vi.fn()}
    />,
  );

const group = () => caseGroup("Explain the refund window.");
/** The words marked as changed in a run's output. */
const marked = (runId: string) =>
  [...cellAt(group(), runId, "Output").querySelectorAll("mark")].map((m) =>
    m.getAttribute("data-text")?.trim(),
  );
const diffAgainst = async (option: string) => {
  if (!screen.queryByRole("dialog", { name: "Display" })) {
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
  }
  const menu = within(await screen.findByRole("dialog", { name: "Display" }));
  fireEvent.click(
    within(menu.getByRole("radiogroup", { name: "Diff against" })).getByRole("radio", {
      name: option,
    }),
  );
};

describe("CompareRunsView — changed words in outputs", () => {
  it("marks a candidate's changed words against the baseline's output by default", () => {
    mount();
    expect(marked("b")).toEqual(["30 business"]);
    expect(marked("a")).toEqual([]);
  });

  it("marks them against the expected output, or not at all, as the Display menu says", async () => {
    mount();
    await diffAgainst("Expected");
    expect(marked("b")).toEqual(["business"]);
    expect(marked("a")).toEqual([]);
    await diffAgainst("Off");
    expect(marked("b")).toEqual([]);
    await diffAgainst("Baseline");
    expect(marked("b")).toEqual(["30 business"]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      diff: "baseline",
    });
  });

  it("marks the same change in every candidate, and nothing where they match the expected output", async () => {
    const matching: RunBundle[] = [
      RUNS[0],
      {
        run: fixtureRun("b", 2, "candidate-v2", "2026-11-02T00:00:00Z"),
        results: [answer("b", EXPECTED)],
      },
      {
        run: fixtureRun("c", 3, "fast-v3", "2026-11-03T00:00:00Z"),
        results: [answer("c", EXPECTED)],
      },
    ];
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: matching.find((b) => b.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    render(
      <CompareRunsView
        projectId="p1"
        runIds={["a", "b", "c"]}
        baselineId="a"
        onChangeBaseline={vi.fn()}
        onChangeRuns={vi.fn()}
        inspected={null}
        onInspect={vi.fn()}
      />,
    );
    expect(marked("b")).toEqual(["30"]);
    expect(marked("c")).toEqual(["30"]);
    expect(marked("a")).toEqual([]);
    await diffAgainst("Expected");
    expect(marked("b")).toEqual([]);
    expect(marked("c")).toEqual([]);
  });

  it("keeps the diff the viewer chose", async () => {
    const { unmount } = mount();
    await diffAgainst("Expected");
    unmount();
    mount();
    expect(marked("b")).toEqual(["business"]);
  });

  it("leaves the output's text as it is, and marks inside clipped text", async () => {
    mount();
    const output = cellAt(group(), "b", "Output");
    const text = within(output).getByText("Refunds are available within 30 business days.");
    // The marks are a layer under the text that adds no text of its own.
    const layer = output.querySelector("mark")?.parentElement as HTMLElement;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.textContent).toBe("");
    expect(layer.className).toContain("truncate");
    expect(layer.parentElement).toBe(text.parentElement);
    await diffAgainst("Off");
    expect(within(output).getByText("Refunds are available within 30 business days.")).toBe(text);
  });

  it("wraps the marks with the text when long text wraps", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ density: "compact", text: "wrap", hidden: [] }),
    );
    mount();
    const layer = cellAt(group(), "b", "Output").querySelector("mark")
      ?.parentElement as HTMLElement;
    expect(layer.className).toContain("whitespace-pre-wrap");
    expect(layer.className).not.toContain("truncate");
  });
});
