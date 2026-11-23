// @vitest-environment jsdom
/**
 * Finding the cases that matter in a comparison, on three runs of one 12-case dataset
 * (see `compare/__tests__/paired-fixture.ts`): the table's search lives in the URL, so a
 * reload or a shared link shows the same cases, and typing writes it once it settles.
 * Filters pick cases by how a run changed or failed on them, and a picked case keeps
 * every run's values. They're added from the toolbar's Filters menu or from the summary
 * row's improved/regressed counts, and each shows as a removable chip. The cases can be
 * sorted worst regression first. With a search or filters on, the summary covers exactly
 * the cases shown and says so, and the trace panel walks them in the table's order. Runs
 * with no input in common and filters that leave nothing each say so, with a way out.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
  POLICY,
  QUALITY,
  ROUTE,
  fixtureResult,
  fixtureRun,
  fixtureScore,
} from "./compare/__tests__/paired-fixture";
import { NO_ANALYSIS, type CaseAnalysis } from "./compare/filters";
import { runsLegend } from "./compare/__tests__/runs-menu";
import { caseGroup, cellAt, columnTexts, summaryGroup } from "./compare/__tests__/table-grid";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({
  useEvaluationRunDetails: vi.fn(),
  useEvaluationRuns: vi.fn(),
}));
vi.mock("./hooks", () => hooks);
// A case opens in the trace panel, which the trace panel's own tests mount for real.
vi.mock("@/features/traces/components", async () => ({
  TraceViewerPanel: (await import("./compare/__tests__/viewer-stand-in")).ViewerStandIn,
}));
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
  const pending = { data: undefined, isLoading: true, isFetching: true, isError: false };
  return { ...actual, useTrace: () => ({ ...pending, refetch: vi.fn() }) };
});

import { CompareRunsView } from "./views/compare-runs-view";

const RUN_IDS = [BASELINE_RUN.id, CANDIDATE_RUN.id, FAST_RUN.id];

beforeEach(() => {
  // Radix Select measures and captures the pointer, which jsdom lacks.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type ViewProps = React.ComponentProps<typeof CompareRunsView>;

const view = (
  analysis: CaseAnalysis,
  onChangeAnalysis = vi.fn(),
  props: Partial<ViewProps> = {},
) => (
  <CompareRunsView
    projectId="p1"
    runIds={RUN_IDS}
    baselineId={null}
    onChangeBaseline={vi.fn()}
    onChangeRuns={vi.fn()}
    inspected={null}
    onInspect={vi.fn()}
    analysis={analysis}
    onChangeAnalysis={onChangeAnalysis}
    {...props}
  />
);
const mount = (analysis: Partial<CaseAnalysis> = {}, props: Partial<ViewProps> = {}) => {
  const onChangeAnalysis = vi.fn();
  const utils = render(view({ ...NO_ANALYSIS, ...analysis }, onChangeAnalysis, props));
  return { ...utils, onChangeAnalysis };
};

/** Each body row's input, in table order. */
const shownInputs = () =>
  Array.from(document.querySelectorAll("tbody tr[data-row]")).map(
    (tr) => tr.querySelector("td")?.textContent,
  );
const search = () => screen.getByRole("textbox", { name: "Search cases" }) as HTMLInputElement;
/** The summary's cell under `header` on `runId`'s line. */
const summaryCell = (runId: string, header: string) => cellAt(summaryGroup(), runId, header);
const chips = () =>
  within(screen.getByRole("group", { name: "Active filters" }))
    .queryAllByRole("button", { name: /^Remove filter/ })
    .map((b) => b.getAttribute("aria-label")?.replace("Remove filter: ", ""));
const filtersButton = () => screen.getByRole("button", { name: "Filters" }) as HTMLButtonElement;
const openFilters = async () => {
  fireEvent.click(filtersButton());
  return within(await screen.findByRole("dialog", { name: "Filters" }));
};
const pick = async (menu: ReturnType<typeof within>, picker: string, option: string) => {
  fireEvent.click(menu.getByRole("combobox", { name: picker }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};
const caseRow = (input: string) => caseGroup(input);

describe("CompareRunsView — search in the URL", () => {
  it("shows the cases the URL's search finds", () => {
    mount({ q: "Ticket 2" });
    expect(search().value).toBe("Ticket 2");
    expect(shownInputs()).toEqual(["Ticket 2"]);
  });

  it("filters as you type, and writes the search once it settles", () => {
    vi.useFakeTimers();
    const { onChangeAnalysis } = mount();
    fireEvent.change(search(), { target: { value: "Ticket" } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(search(), { target: { value: "Ticket 3" } });
    expect(shownInputs()).toEqual(["Ticket 3"]);
    act(() => vi.advanceTimersByTime(299));
    expect(onChangeAnalysis).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onChangeAnalysis).toHaveBeenCalledTimes(1);
    expect(onChangeAnalysis).toHaveBeenCalledWith({ ...NO_ANALYSIS, q: "Ticket 3" });
  });

  it("takes a search that arrives from the URL, as on back or forward", () => {
    const { rerender, onChangeAnalysis } = mount({ q: "Ticket 2" });
    rerender(view({ ...NO_ANALYSIS, q: "Ticket 3" }, onChangeAnalysis));
    expect(search().value).toBe("Ticket 3");
    expect(shownInputs()).toEqual(["Ticket 3"]);
  });

  it("keeps typing when its own write comes back from the URL", () => {
    vi.useFakeTimers();
    const { rerender, onChangeAnalysis } = mount();
    fireEvent.change(search(), { target: { value: "Ticket" } });
    act(() => vi.advanceTimersByTime(300));
    expect(onChangeAnalysis).toHaveBeenLastCalledWith({ ...NO_ANALYSIS, q: "Ticket" });
    // More typing lands before the URL catches up with the first write.
    fireEvent.change(search(), { target: { value: "Ticket 3" } });
    rerender(view({ ...NO_ANALYSIS, q: "Ticket" }, onChangeAnalysis));
    expect(search().value).toBe("Ticket 3");
    act(() => vi.advanceTimersByTime(300));
    expect(onChangeAnalysis).toHaveBeenLastCalledWith({ ...NO_ANALYSIS, q: "Ticket 3" });
  });

  it("doesn't write a search that only gained spaces at the end", () => {
    vi.useFakeTimers();
    const { onChangeAnalysis } = mount({ q: "Ticket" });
    fireEvent.change(search(), { target: { value: "Ticket " } });
    act(() => vi.advanceTimersByTime(300));
    expect(onChangeAnalysis).not.toHaveBeenCalled();
    expect(search().value).toBe("Ticket ");
  });
});

describe("CompareRunsView — filters from the URL", () => {
  it("shows only the cases a filter picks, with every run's values", () => {
    mount({ filters: [{ kind: "regressed", scorer: QUALITY, runId: CANDIDATE_RUN.id }] });
    expect(shownInputs()).toEqual(["Ticket 2"]);
    // #1, #2 and #3 all keep their value; #2 shows its change against the baseline.
    expect(columnTexts(caseRow("Ticket 2"), QUALITY)).toEqual([
      "85.0%",
      "30.0%−55.0 pp",
      "80.0%−5.0 pp",
    ]);
  });

  it("shows a run's missing result in the cases it picks for being unmatched", () => {
    mount({ filters: [{ kind: "unmatched", scorer: "any", runId: "any" }] });
    expect(shownInputs()).toEqual(["Ticket 9", "Ticket 10"]);
    expect(within(caseRow("Ticket 9")).getByText("No result in this run")).toBeTruthy();
  });

  it("keeps only the cases every filter and the search pick", () => {
    mount({
      q: "Ticket 1",
      filters: [
        { kind: "improved", scorer: QUALITY, runId: CANDIDATE_RUN.id },
        { kind: "regressed", scorer: QUALITY, runId: FAST_RUN.id },
      ],
    });
    // #2 improved on 1, 11 and 12 of the "Ticket 1…" cases; #3 regressed on 11 and 12.
    expect(shownInputs()).toEqual(["Ticket 11", "Ticket 12"]);
  });
});

describe("CompareRunsView — header counts filter the table", () => {
  it("shows one candidate's regressions on a scorer from its count", () => {
    vi.useFakeTimers();
    const { onChangeAnalysis } = mount();
    const count = within(summaryCell(CANDIDATE_RUN.id, QUALITY)).getByRole("button", {
      name: "Show 1 case where #2 regressed on quality",
    });
    expect(count.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(count);
    expect(shownInputs()).toEqual(["Ticket 2"]);
    expect(chips()).toEqual(["Regressed · quality · #2"]);
    expect(count.getAttribute("aria-pressed")).toBe("true");
    act(() => vi.advanceTimersByTime(300));
    expect(onChangeAnalysis).toHaveBeenLastCalledWith({
      ...NO_ANALYSIS,
      filters: [{ kind: "regressed", scorer: QUALITY, runId: CANDIDATE_RUN.id }],
    });
  });

  it("takes the filter off again from the same count", () => {
    mount({ filters: [{ kind: "regressed", scorer: QUALITY, runId: CANDIDATE_RUN.id }] });
    fireEvent.click(
      screen.getByRole("button", { name: "Show 1 case where #2 regressed on quality" }),
    );
    expect(shownInputs()).toHaveLength(12);
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
  });

  it("names each count for the cases it shows, and can't filter to none", () => {
    mount();
    expect(
      within(summaryCell(CANDIDATE_RUN.id, QUALITY)).getByRole("button", {
        name: "Show 6 cases where #2 improved on quality",
      }),
    ).toBeTruthy();
    expect(
      within(summaryCell(FAST_RUN.id, QUALITY)).getByRole("button", {
        name: "Show 10 cases where #3 regressed on quality",
      }),
    ).toBeTruthy();
    const none = within(summaryCell(CANDIDATE_RUN.id, POLICY)).getByRole("button", {
      name: "Show 0 cases where #2 improved on policy_violations",
    }) as HTMLButtonElement;
    expect(none.disabled).toBe(true);
  });
});

describe("CompareRunsView — the Filters menu", () => {
  it("adds a filter for a metric and a candidate", async () => {
    mount();
    const menu = await openFilters();
    await pick(menu, "Metric", QUALITY);
    await pick(menu, "Run", "#2 candidate-v2");
    fireEvent.click(menu.getByRole("button", { name: /^Regressed/ }));
    expect(chips()).toEqual(["Regressed · quality · #2"]);
    expect(shownInputs()).toEqual(["Ticket 2"]);
    // The menu closes once a filter is added.
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
  });

  it("filters on any metric and any run unless told otherwise", async () => {
    mount();
    fireEvent.click((await openFilters()).getByRole("button", { name: /^Errors/ }));
    expect(chips()).toEqual(["Errors · any metric · any run"]);
    expect(shownInputs()).toEqual(["Ticket 6", "Ticket 7"]);
  });

  it("falls back to any run once the run it was set to leaves the comparison", async () => {
    const { rerender, onChangeAnalysis } = mount();
    const menu = await openFilters();
    await pick(menu, "Run", "#3 fast-v3");
    fireEvent.click(menu.getByRole("button", { name: /^Errors/ }));
    expect(chips()).toEqual(["Errors · any metric · #3"]);
    rerender(
      <CompareRunsView
        projectId="p1"
        runIds={[BASELINE_RUN.id, CANDIDATE_RUN.id]}
        baselineId={null}
        onChangeBaseline={vi.fn()}
        onChangeRuns={vi.fn()}
        inspected={null}
        onInspect={vi.fn()}
        analysis={NO_ANALYSIS}
        onChangeAnalysis={onChangeAnalysis}
      />,
    );
    const again = await openFilters();
    expect(again.getByRole("combobox", { name: "Run" }).textContent).toBe("Any run");
  });

  it("can't ask a metric with no direction for improvements or regressions", async () => {
    mount();
    const menu = await openFilters();
    await pick(menu, "Metric", ROUTE);
    const kind = (name: RegExp) => menu.getByRole("button", { name }) as HTMLButtonElement;
    expect(kind(/^Improved/).disabled).toBe(true);
    expect(kind(/^Regressed/).disabled).toBe(true);
    expect(kind(/^Changed/).disabled).toBe(false);
    // Each unavailable kind says why.
    expect(kind(/^Improved/).textContent).toBe("Improved metric has no direction");
    expect(kind(/^Changed/).textContent).toBe("Changed different from the baseline");
  });

  it("can't ask the baseline how it changed against itself", async () => {
    mount();
    const menu = await openFilters();
    await pick(menu, "Run", "#1 baseline-v1 · baseline");
    const kind = (name: RegExp) => menu.getByRole("button", { name }) as HTMLButtonElement;
    for (const name of [/^Improved/, /^Regressed/, /^Changed/])
      expect(kind(name).disabled).toBe(true);
    expect(kind(/^Regressed/).textContent).toBe("Regressed pick a run other than the baseline");
    fireEvent.click(kind(/^Unmatched/));
    expect(chips()).toEqual(["Unmatched · #1"]);
    expect(shownInputs()).toEqual(["Ticket 10"]);
  });

  it("removes a filter from its chip, and clears them all with the search", () => {
    mount({
      q: "Ticket",
      filters: [
        { kind: "regressed", scorer: QUALITY, runId: FAST_RUN.id },
        { kind: "errors", scorer: "any", runId: "any" },
      ],
    });
    expect(shownInputs()).toEqual(["Ticket 6", "Ticket 7"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove filter: Errors · any metric · any run" }),
    );
    expect(chips()).toEqual(["Regressed · quality · #3"]);
    expect(shownInputs()).toHaveLength(10);
    // The chip's button is gone, so focus lands where filters are added.
    expect(document.activeElement).toBe(filtersButton());
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
    expect(search().value).toBe("");
    expect(shownInputs()).toHaveLength(12);
    expect(document.activeElement).toBe(filtersButton());
  });

  it("says what Clear takes off", () => {
    mount({ filters: [{ kind: "errors", scorer: "any", runId: "any" }] });
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });
});

describe("CompareRunsView — sorting by regression", () => {
  const sortControl = () => screen.getByRole("combobox", { name: /^Sort cases/ });

  it("puts the URL's sort's worst regression first", () => {
    mount({ sort: { kind: "regression", scorer: QUALITY, runId: CANDIDATE_RUN.id } });
    // A short label keeps the analysis row on one line; its name says it in full.
    expect(sortControl().textContent).toBe("↘ quality · #2");
    expect(sortControl().getAttribute("aria-label")).toBe(
      "Sort cases: Largest regression · quality · #2",
    );
    expect(shownInputs().slice(0, 7)).toEqual([
      "Ticket 2",
      "Ticket 3",
      "Ticket 4",
      "Ticket 5",
      "Ticket 11",
      "Ticket 12",
      "Ticket 1",
    ]);
  });

  it("sorts from the Sort control, and back to dataset order", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onChangeAnalysis } = mount();
    fireEvent.click(sortControl());
    fireEvent.click(
      await screen.findByRole("option", { name: "Largest regression · quality · #2" }),
    );
    expect(shownInputs()[0]).toBe("Ticket 2");
    expect(shownInputs()[6]).toBe("Ticket 1");
    act(() => vi.advanceTimersByTime(300));
    expect(onChangeAnalysis).toHaveBeenLastCalledWith({
      ...NO_ANALYSIS,
      sort: { kind: "regression", scorer: QUALITY, runId: CANDIDATE_RUN.id },
    });
    fireEvent.click(sortControl());
    fireEvent.click(await screen.findByRole("option", { name: "Dataset order" }));
    expect(shownInputs()[0]).toBe("Ticket 1");
  });

  it("can't sort by a metric with no direction", async () => {
    mount();
    fireEvent.click(sortControl());
    const route = await screen.findByRole("option", {
      name: "Largest regression · route (no direction)",
    });
    expect(route.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the filters while sorting", () => {
    mount({
      filters: [{ kind: "changed", scorer: QUALITY, runId: CANDIDATE_RUN.id }],
      sort: { kind: "regression", scorer: QUALITY, runId: CANDIDATE_RUN.id },
    });
    expect(shownInputs()).toEqual([
      "Ticket 2",
      "Ticket 3",
      "Ticket 4",
      "Ticket 5",
      "Ticket 11",
      "Ticket 12",
      "Ticket 1",
    ]);
  });
});

describe("CompareRunsView — the summary over the cases shown", () => {
  const regressedOnQuality = {
    kind: "regressed",
    scorer: QUALITY,
    runId: CANDIDATE_RUN.id,
  } as const;

  it("summarises only the matching cases, and says how many of all of them", () => {
    mount({ filters: [regressedOnQuality] });
    expect(screen.getByText("1 matching · 12 total")).toBeTruthy();
    const quality = within(summaryCell(CANDIDATE_RUN.id, QUALITY));
    // #2 on case 2 alone: 85% → 30%, one regression and no improvement.
    expect(quality.getByText("85.0% → 30.0%")).toBeTruthy();
    expect(quality.getByText("−55.0 pp")).toBeTruthy();
    expect(quality.getByText("n=1")).toBeTruthy();
    expect(within(summaryCell(FAST_RUN.id, QUALITY)).getByText("n=1")).toBeTruthy();
    expect(
      quality
        .getByRole("button", { name: "Show 1 case where #2 regressed on quality" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const improved = quality.getByRole("button", {
      name: "Show 0 cases where #2 improved on quality",
    }) as HTMLButtonElement;
    expect(improved.disabled).toBe(true);
    // Latency and cost cover the same case.
    for (const runId of [CANDIDATE_RUN.id, FAST_RUN.id]) {
      expect(within(summaryCell(runId, "Latency")).getByText("n=1")).toBeTruthy();
    }
  });

  it("takes the cost mean over the matching cases too", () => {
    mount({ filters: [regressedOnQuality] });
    for (const runId of [CANDIDATE_RUN.id, FAST_RUN.id]) {
      expect(within(summaryCell(runId, "Cost")).getByText("n=1")).toBeTruthy();
    }
  });

  it("agrees with the rows it filters to", () => {
    mount({ filters: [{ kind: "regressed", scorer: QUALITY, runId: FAST_RUN.id }] });
    expect(shownInputs()).toHaveLength(10);
    expect(screen.getByText("10 matching · 12 total")).toBeTruthy();
    expect(
      within(summaryCell(FAST_RUN.id, QUALITY)).getByRole("button", {
        name: "Show 10 cases where #3 regressed on quality",
      }),
    ).toBeTruthy();
  });

  it("scopes the summary to a search alone", () => {
    mount({ q: "Ticket 1" });
    expect(screen.getByText("4 matching · 12 total")).toBeTruthy();
    // Cases 1, 11 and 12 are in #1 and #2; case 10 isn't in #1.
    expect(within(summaryCell(CANDIDATE_RUN.id, QUALITY)).getByText("n=3")).toBeTruthy();
  });

  it("keeps the coverage line when nothing narrows the cases, sorted or not", () => {
    mount({ sort: { kind: "regression", scorer: QUALITY, runId: CANDIDATE_RUN.id } });
    expect(screen.getByText("12 cases · 10 in all runs")).toBeTruthy();
    expect(screen.queryByText(/matching/)).toBeNull();
  });

  it("walks the trace panel through the cases shown, in the table's order", () => {
    const onInspect = vi.fn();
    mount(
      {
        filters: [{ kind: "changed", scorer: QUALITY, runId: CANDIDATE_RUN.id }],
        sort: { kind: "regression", scorer: QUALITY, runId: CANDIDATE_RUN.id },
      },
      { inspected: { caseToken: "id:case-12", pair: null }, onInspect },
    );
    // Shown: 2, 3, 4, 5, 11, 12, 1 — case 12 is the 6th of 7.
    const inspector = screen.getByRole("dialog", { name: "Case 6 of 7" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Next case" }));
    expect(onInspect).toHaveBeenLastCalledWith(expect.objectContaining({ caseToken: "id:case-1" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "Previous case" }));
    expect(onInspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ caseToken: "id:case-11" }),
    );
  });
});

describe("CompareRunsView — changing runs keeps only the filters that still apply", () => {
  /** Radix opens a menu on pointerdown, not a bare click. */
  const runMenu = async (name: RegExp, item: string) => {
    fireEvent.pointerDown(within(await runsLegend()).getByRole("button", { name }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  };
  const onCandidate = (runId: string) => [
    { kind: "regressed" as const, scorer: QUALITY, runId },
    { kind: "errors" as const, scorer: "any", runId },
  ];

  it("drops the change filters and the sort on a run that becomes the baseline", async () => {
    const onChangeBaseline = vi.fn();
    mount(
      {
        filters: [
          ...onCandidate(CANDIDATE_RUN.id),
          { kind: "unmatched", scorer: "any", runId: "any" },
        ],
        sort: { kind: "regression", scorer: QUALITY, runId: CANDIDATE_RUN.id },
      },
      { onChangeBaseline },
    );
    await runMenu(/#2 candidate-v2/, "Set as baseline");
    // #2 can't regress against itself; its errors and the unmatched filter still apply.
    const kept = {
      q: "",
      filters: [
        { kind: "errors", scorer: "any", runId: CANDIDATE_RUN.id },
        { kind: "unmatched", scorer: "any", runId: "any" },
      ],
      sort: { kind: "dataset" },
    };
    // With the baseline it replaces, so the trace panel can follow the table.
    expect(onChangeBaseline).toHaveBeenCalledWith(CANDIDATE_RUN.id, kept, BASELINE_RUN.id);
    expect(chips()).toEqual(["Errors · any metric · #2", "Unmatched · any run"]);
  });

  it("carries a filter that hasn't reached the URL yet into the change, and writes nothing after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onChangeBaseline = vi.fn();
    const { onChangeAnalysis } = mount({}, { onChangeBaseline });
    fireEvent.click(
      screen.getByRole("button", { name: "Show 10 cases where #3 regressed on quality" }),
    );
    await runMenu(/#2 candidate-v2/, "Set as baseline");
    expect(onChangeBaseline).toHaveBeenCalledWith(
      CANDIDATE_RUN.id,
      { ...NO_ANALYSIS, filters: [{ kind: "regressed", scorer: QUALITY, runId: FAST_RUN.id }] },
      BASELINE_RUN.id,
    );
    act(() => vi.advanceTimersByTime(300));
    expect(onChangeAnalysis).not.toHaveBeenCalled();
  });

  it("drops every filter and the sort on a run that leaves the comparison", async () => {
    const onChangeRuns = vi.fn();
    mount(
      {
        filters: onCandidate(FAST_RUN.id),
        sort: { kind: "regression", scorer: QUALITY, runId: FAST_RUN.id },
      },
      { onChangeRuns },
    );
    await runMenu(/#3 fast-v3/, "Remove from comparison");
    expect(onChangeRuns).toHaveBeenCalledWith(
      [BASELINE_RUN.id, CANDIDATE_RUN.id],
      BASELINE_RUN.id,
      NO_ANALYSIS,
    );
  });

  it("drops the filters on runs that couldn't be loaded along with them", () => {
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: id === FAST_RUN.id ? undefined : PAIRED_FIXTURE.find((b) => b.run.id === id),
        isLoading: false,
        isError: id === FAST_RUN.id,
        refetch: vi.fn(),
      })),
    );
    const onChangeRuns = vi.fn();
    const unmatched = { kind: "unmatched" as const, scorer: "any", runId: "any" };
    mount({ filters: [...onCandidate(FAST_RUN.id), unmatched] }, { onChangeRuns });
    fireEvent.click(screen.getByRole("button", { name: "Remove missing runs" }));
    expect(onChangeRuns).toHaveBeenCalledWith([BASELINE_RUN.id, CANDIDATE_RUN.id], null, {
      ...NO_ANALYSIS,
      filters: [unmatched],
    });
  });

  it("reads the run that takes over as the baseline when the baseline leaves", async () => {
    const onChangeRuns = vi.fn();
    mount({ filters: onCandidate(CANDIDATE_RUN.id) }, { onChangeRuns });
    await runMenu(/#1 baseline-v1/, "Remove from comparison");
    // #2 is the oldest run left, so it becomes the baseline and can't regress against itself.
    expect(onChangeRuns).toHaveBeenCalledWith([CANDIDATE_RUN.id, FAST_RUN.id], null, {
      ...NO_ANALYSIS,
      filters: [{ kind: "errors", scorer: "any", runId: CANDIDATE_RUN.id }],
    });
  });
});

describe("CompareRunsView — when no case is left", () => {
  it("says the runs have no matching inputs, and how to change them", async () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z", {
      datasetId: "ds2",
      datasetName: "refunds",
    });
    const runs = [
      { run: a, results: [fixtureResult("a", "tc-1", "Ticket 1", [fixtureScore(QUALITY, 1)])] },
      { run: b, results: [fixtureResult("b", "tc-9", "Refund 9", [fixtureScore(QUALITY, 1)])] },
    ];
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: runs.find((x) => x.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    mount({}, { runIds: ["a", "b"] });
    expect(screen.getByText("These runs have no matching inputs")).toBeTruthy();
    expect(screen.getByText(/different datasets \(support-tickets, refunds\)/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    // Two runs can't lose one, so the way out starts with adding one.
    const empty = screen.getByText("These runs have no matching inputs").parentElement!;
    expect(
      within(empty).getByText(
        "Add a run that shares inputs with one of these, then remove the other from the Runs menu above.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(empty).getByRole("button", { name: "Add runs" }));
    expect(await screen.findByRole("dialog", { name: "Add runs" })).toBeTruthy();
  });

  it("points to removing a run when there are more than two", () => {
    const runs = ["a", "b", "c"].map((id, i) => ({
      run: fixtureRun(id, i + 1, id, `2026-11-0${i + 1}T00:00:00Z`, {
        datasetId: `ds-${id}`,
        datasetName: `set-${id}`,
      }),
      results: [fixtureResult(id, `tc-${id}`, `Input ${id}`, [fixtureScore(QUALITY, 1)])],
    }));
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: runs.find((x) => x.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    mount({}, { runIds: ["a", "b", "c"] });
    expect(
      screen.getByText(
        "Remove a run from the Runs menu above, or add one that shares their inputs.",
      ),
    ).toBeTruthy();
  });

  it("says no case matches, and clears the search and filters but keeps the sort", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sort = { kind: "regression", scorer: QUALITY, runId: CANDIDATE_RUN.id } as const;
    const { onChangeAnalysis } = mount({
      q: "Ticket 1",
      filters: [{ kind: "regressed", scorer: QUALITY, runId: CANDIDATE_RUN.id }],
      sort,
    });
    expect(screen.getByText("No cases match the search or filters")).toBeTruthy();
    expect(screen.getByText("0 matching · 12 total")).toBeTruthy();
    expect(screen.queryByText("These runs have no matching inputs")).toBeNull();
    // The same action, under the same name, as the toolbar's.
    const clears = screen.getAllByRole("button", { name: "Clear search and filters" });
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[1]);
    expect(document.activeElement).toBe(filtersButton());
    expect(search().value).toBe("");
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
    expect(shownInputs()).toHaveLength(12);
    // Still worst regression first.
    expect(shownInputs()[0]).toBe("Ticket 2");
    act(() => vi.advanceTimersByTime(300));
    expect(onChangeAnalysis).toHaveBeenLastCalledWith({ q: "", filters: [], sort });
  });
});

describe("CompareRunsView — the toolbar's controls", () => {
  it("can't filter or sort until the runs load", () => {
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map(() => ({ data: undefined, isLoading: true, isError: false })),
    );
    mount();
    expect(screen.getByText("Comparing…")).toBeTruthy();
    expect(filtersButton().disabled).toBe(true);
    const sort = screen.getByRole("combobox", { name: /^Sort cases/ }) as HTMLButtonElement;
    expect(sort.disabled).toBe(true);
  });

  it("sends focus to the search when a chip is removed while the runs reload", () => {
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map(() => ({ data: undefined, isLoading: true, isError: false })),
    );
    mount({ filters: [{ kind: "regressed", scorer: QUALITY, runId: CANDIDATE_RUN.id }] });
    expect(filtersButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Remove filter:/ }));
    expect(document.activeElement).toBe(search());
  });

  it("keeps every control at the search's height", () => {
    mount();
    const controls = [
      search(),
      filtersButton(),
      screen.getByRole("combobox", { name: /^Sort cases/ }),
      screen.getByRole("button", { name: /^Runs \(/ }),
      screen.getByRole("button", { name: "Export" }),
    ];
    for (const control of controls) {
      expect(control.className).toMatch(/\bh-8\b/);
      expect(control.className).not.toMatch(/\bh-7\b/);
    }
  });
});
