// @vitest-environment jsdom
/**
 * The run comparison page's legend, in the toolbar's Runs menu: one chip per run naming it,
 * the baseline marked, and a menu on each chip to make it the baseline, remove it, or open
 * it. Runs keep their colour whichever run is the baseline and whichever other run is
 * removed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, within, fireEvent } from "@testing-library/react";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
} from "./compare/__tests__/paired-fixture";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
vi.mock("./hooks", () => hooks);

import { runsLegendNow } from "./compare/__tests__/runs-menu";
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
});
afterEach(() => cleanup());

const view = (props: Partial<React.ComponentProps<typeof CompareRunsView>> = {}) => (
  <CompareRunsView
    projectId="p1"
    runIds={RUN_IDS}
    baselineId={null}
    onChangeBaseline={vi.fn()}
    onChangeRuns={vi.fn()}
    {...props}
  />
);

const legend = runsLegendNow;
const chip = (name: RegExp) => within(legend()).getByRole("button", { name });
/** The colour class of a chip's dot. */
const dotOf = (name: RegExp) =>
  [...(chip(name).querySelector(".rounded-full")?.classList ?? [])].find((c) =>
    c.startsWith("bg-"),
  );
/** Radix opens a menu on pointerdown, not a bare click. */
const openMenu = (name: RegExp) => fireEvent.pointerDown(chip(name), { button: 0, ctrlKey: false });

describe("CompareRunsView — run legend", () => {
  it("names each run and marks the baseline", () => {
    render(view());
    const chips = within(legend()).getAllByRole("button");
    // Add runs follows the last run.
    expect(chips.map((c) => c.textContent)).toEqual([
      "#1 baseline-v1Baseline",
      "#2 candidate-v2",
      "#3 fast-v3",
      "Add runs",
    ]);
    // The legend replaces the standalone baseline picker.
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });

  it("says a run's status when it did not complete", () => {
    const runs = PAIRED_FIXTURE.map((b) =>
      b.run.id === FAST_RUN.id ? { ...b, run: { ...b.run, status: "incomplete" as const } } : b,
    );
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: runs.find((b) => b.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    render(view());
    expect(chip(/#3 fast-v3/).textContent).toBe("#3 fast-v3Incomplete");
  });

  it("names the evaluation too when the runs span evaluations", () => {
    const runs = PAIRED_FIXTURE.map((b) =>
      b.run.id === FAST_RUN.id
        ? { ...b, run: { ...b.run, evaluationId: "ev2", evaluationName: "fast-routing" } }
        : b,
    );
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: runs.find((b) => b.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    render(view());
    expect(chip(/fast-routing #3 fast-v3/)).toBeTruthy();
    expect(chip(/support-routing #1 baseline-v1/)).toBeTruthy();
  });

  it("makes a run the baseline from its chip", async () => {
    const onChangeBaseline = vi.fn();
    render(view({ onChangeBaseline }));
    openMenu(/#2 candidate-v2/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set as baseline" }));
    expect(onChangeBaseline).toHaveBeenCalledWith(CANDIDATE_RUN.id);
  });

  it("keeps every run's colour when the baseline changes", () => {
    const { rerender } = render(view());
    const before = [/#1 baseline-v1/, /#2 candidate-v2/, /#3 fast-v3/].map(dotOf);
    rerender(view({ baselineId: CANDIDATE_RUN.id }));
    expect(chip(/#2 candidate-v2/).textContent).toContain("Baseline");
    expect([/#1 baseline-v1/, /#2 candidate-v2/, /#3 fast-v3/].map(dotOf)).toEqual(before);
  });

  it("removes a run from the comparison, keeping the baseline and the other runs' colours", async () => {
    const onChangeRuns = vi.fn();
    const { rerender } = render(view({ onChangeRuns }));
    const fastDot = dotOf(/#3 fast-v3/);
    openMenu(/#2 candidate-v2/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from comparison" }));
    // No baseline in the URL: #1 is the baseline as the oldest run, and stays it.
    expect(onChangeRuns).toHaveBeenCalledWith([BASELINE_RUN.id, FAST_RUN.id], BASELINE_RUN.id);
    rerender(view({ onChangeRuns, runIds: [BASELINE_RUN.id, FAST_RUN.id] }));
    expect(dotOf(/#3 fast-v3/)).toBe(fastDot);
  });

  it("lets the default baseline take over when the baseline is removed", async () => {
    const onChangeRuns = vi.fn();
    render(view({ onChangeRuns }));
    openMenu(/#1 baseline-v1/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from comparison" }));
    expect(onChangeRuns).toHaveBeenCalledWith([CANDIDATE_RUN.id, FAST_RUN.id], null);
  });

  it("sets the baseline from a run's menu only on a run that isn't the baseline", async () => {
    render(view());
    openMenu(/#1 baseline-v1/);
    const set = await screen.findByRole("menuitem", { name: "Set as baseline" });
    expect(set.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps at least two runs in the comparison", async () => {
    render(view({ runIds: [BASELINE_RUN.id, CANDIDATE_RUN.id] }));
    openMenu(/#2 candidate-v2/);
    const remove = await screen.findByRole("menuitem", { name: "Remove from comparison" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
  });

  it("opens a run from its chip", async () => {
    render(view());
    openMenu(/#3 fast-v3/);
    const open = await screen.findByRole("menuitem", { name: "Open run" });
    expect(open.getAttribute("href")).toBe(`/projects/p1/evaluations/${FAST_RUN.id}`);
  });
});
