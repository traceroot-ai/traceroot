// @vitest-environment jsdom
/**
 * Above the comparison table, one row: the search and the Runs menu. Runs (N) opens the runs compared, each with its menu to
 * make it the baseline, remove it or open it, and Add runs, which turns the same panel into
 * the run picker. Under the toolbar, one muted line says how many cases there are and how
 * many every run has, with the runs that fall short of their cases noted on hover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
} from "./compare/__tests__/paired-fixture";
import { openRuns, runsLegend } from "./compare/__tests__/runs-menu";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({
  useEvaluationRunDetails: vi.fn(),
  useEvaluationRuns: vi.fn(),
}));
vi.mock("./hooks", () => hooks);

import { CompareRunsView } from "./views/compare-runs-view";

const RUN_IDS = [BASELINE_RUN.id, CANDIDATE_RUN.id, FAST_RUN.id];

beforeEach(() => {
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: PAIRED_FIXTURE.find((b) => b.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
  hooks.useEvaluationRuns.mockReturnValue({
    data: { data: [], meta: { page: 0, limit: 20, total: 0 } },
    isLoading: false,
  });
});
afterEach(() => cleanup());

const mount = (props: Partial<React.ComponentProps<typeof CompareRunsView>> = {}) =>
  render(
    <CompareRunsView
      projectId="p1"
      runIds={RUN_IDS}
      baselineId={null}
      onChangeBaseline={vi.fn()}
      onChangeRuns={vi.fn()}
      {...props}
    />,
  );
/** Radix opens a menu on pointerdown, not a bare click. */
const runMenu = async (name: RegExp, item: string) => {
  fireEvent.pointerDown(within(await runsLegend()).getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
};

describe("CompareRunsView — one-row toolbar", () => {
  it("puts search and runs on one row", () => {
    mount();
    expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    const row = within(document.querySelector('[data-toolbar="cases"]') as HTMLElement);
    const controls = [
      row.getByRole("textbox", { name: "Search cases" }),
      row.getByRole("button", { name: "Runs (3)" }),
    ];
    for (const [a, b] of controls.slice(1).map((c, i) => [controls[i], c])) {
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The runs are in the menu, not on a row of their own.
    expect(screen.queryByRole("group", { name: "Runs in this comparison" })).toBeNull();
  });

  it("keeps the Runs button in place while the runs load", () => {
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map(() => ({ data: undefined, isLoading: true, isError: false })),
    );
    mount();
    const runs = screen.getByRole("button", { name: "Runs (3)" }) as HTMLButtonElement;
    expect(runs.disabled).toBe(true);
  });
});

describe("CompareRunsView — the Runs menu", () => {
  it("lists the runs compared, baseline first and marked, then Add runs", async () => {
    mount();
    const legend = within(await runsLegend());
    expect(legend.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "#1 baseline-v1Baseline",
      "#2 candidate-v2",
      "#3 fast-v3",
      "Add runs",
    ]);
  });

  it("makes a run the baseline, removes one, or opens one", async () => {
    const onChangeBaseline = vi.fn();
    const onChangeRuns = vi.fn();
    mount({ onChangeBaseline, onChangeRuns });
    await runMenu(/#2 candidate-v2/, "Set as baseline");
    expect(onChangeBaseline).toHaveBeenCalledWith(CANDIDATE_RUN.id);
    await runMenu(/#3 fast-v3/, "Remove from comparison");
    expect(onChangeRuns).toHaveBeenCalledWith([BASELINE_RUN.id, CANDIDATE_RUN.id], BASELINE_RUN.id);
    fireEvent.pointerDown(within(await runsLegend()).getByRole("button", { name: /#3 fast-v3/ }), {
      button: 0,
      ctrlKey: false,
    });
    const open = await screen.findByRole("menuitem", { name: "Open run" });
    expect(open.getAttribute("href")).toBe(`/projects/p1/evaluations/${FAST_RUN.id}`);
  });

  it("adds runs from the same panel", async () => {
    mount();
    const menu = await openRuns();
    fireEvent.click(menu.getByRole("button", { name: "Add runs" }));
    const picker = within(await screen.findByRole("dialog", { name: "Add runs" }));
    expect(picker.getByRole("textbox", { name: "Search runs" })).toBeTruthy();
    expect(document.activeElement).toBe(picker.getByRole("textbox", { name: "Search runs" }));
    // Closed and opened again, it lists the runs.
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(within(await runsLegend()).getByRole("button", { name: "Add runs" })).toBeTruthy();
  });
});

describe("CompareRunsView — the coverage line", () => {
  it("says how many cases there are and how many every run has, on one muted line", () => {
    mount();
    const line = screen.getByText("12 cases · 10 in all runs").closest("p") as HTMLElement;
    expect(line.className).toContain("text-muted-foreground");
    expect(line.closest("[data-toolbar]")).toBeNull();
  });

  it("notes the runs short of their cases on the same line, each run's reason on hover", async () => {
    const runs = PAIRED_FIXTURE.map((b) => ({
      ...b,
      run: { ...b.run, caseCount: 12, resultsTruncated: b.results.length < 12 },
    }));
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: runs.find((b) => b.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    mount();
    const note = screen.getByText("2 runs are missing cases");
    expect(note.closest("p")).toBe(screen.getByText("12 cases · 10 in all runs").closest("p"));
    expect(note.querySelector("svg")).toBeTruthy();
    fireEvent.focus(note);
    const tip = within(await screen.findByRole("tooltip"));
    expect(tip.getByText("#1 reported 11 of 12 cases.")).toBeTruthy();
    expect(tip.getByText("#2 reported 11 of 12 cases.")).toBeTruthy();
  });
});
