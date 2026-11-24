// @vitest-environment jsdom
/**
 * The comparison table reads one case at a time: each case is a group of lines, one per
 * run, the baseline first and muted, then the other runs in display order. Input and
 * Expected span the group; the Run column names each line. A candidate's line shows its
 * value and its change against the baseline; the baseline's line shows values only.
 * Hovering a line highlights its whole group, a click on a line opens the case on that
 * line's run, and each group is one tab stop. The label row, Input and Run stay pinned.
 */
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
  scorerManifest,
} from "./compare/__tests__/paired-fixture";
import {
  caseGroup,
  caseGroups,
  cellAt,
  columnTexts,
  linesOf,
  lineOf,
  shownText,
  summaryGroup,
} from "./compare/__tests__/table-grid";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
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
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: PAIRED_FIXTURE.find((b) => b.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
});
afterEach(() => cleanup());

const mount = () => {
  const onInspect = vi.fn();
  render(
    <CompareRunsView
      projectId="p1"
      runIds={RUN_IDS}
      baselineId={null}
      onChangeBaseline={vi.fn()}
      onChangeRuns={vi.fn()}
      inspected={null}
      onInspect={onInspect}
    />,
  );
  return onInspect;
};

describe("CompareRunsView — one line per run", () => {
  it("lays out each case as a group of lines, the baseline's first", () => {
    mount();
    expect(caseGroups()).toHaveLength(12);
    for (const group of caseGroups()) {
      expect(linesOf(group).map((l) => l.dataset.runId)).toEqual(RUN_IDS);
    }
    const group = caseGroup("Ticket 2");
    expect(columnTexts(group, "Run")).toEqual(["#1", "#2", "#3"]);
    expect(columnTexts(group, "Output")).toEqual(["run-1 output", "run-2 output", "run-3 output"]);
  });

  it("spans Input and Expected across the group's lines", () => {
    mount();
    const group = caseGroup("Ticket 2");
    const input = cellAt(group, CANDIDATE_RUN.id, "Input");
    expect(input).toBe(cellAt(group, BASELINE_RUN.id, "Input"));
    expect(input.rowSpan).toBe(3);
    expect(cellAt(group, FAST_RUN.id, "Expected").rowSpan).toBe(3);
    expect(within(group).getAllByText("Ticket 2")).toHaveLength(1);
  });

  it("names each line's run, with its version on hover", async () => {
    mount();
    const run = cellAt(caseGroup("Ticket 2"), CANDIDATE_RUN.id, "Run");
    expect(run.tagName).toBe("TH");
    expect(run.getAttribute("scope")).toBe("row");
    expect(run.querySelector(".rounded-full")).toBeTruthy();
    // The same inset on every line, first cell of its row or not.
    expect(run.className).toContain("!pl-3");
    fireEvent.focus(within(run).getByText("#2"));
    expect(within(await screen.findByRole("tooltip")).getByText("#2 candidate-v2")).toBeTruthy();
  });

  it("says on hover which line is the baseline's", async () => {
    mount();
    const run = cellAt(caseGroup("Ticket 2"), BASELINE_RUN.id, "Run");
    fireEvent.focus(within(run).getByText("#1"));
    expect(
      within(await screen.findByRole("tooltip")).getByText("#1 baseline-v1 · Baseline"),
    ).toBeTruthy();
  });

  it("shows the baseline's values muted and without a change", () => {
    mount();
    const group = caseGroup("Ticket 2");
    expect(lineOf(group, BASELINE_RUN.id).className).toContain("text-muted-foreground");
    expect(lineOf(group, CANDIDATE_RUN.id).className).not.toContain("text-muted-foreground");
    expect(columnTexts(group, QUALITY)).toEqual(["85.0%", "30.0%−55.0 pp", "80.0%−5.0 pp"]);
    expect(columnTexts(group, "Latency")).toEqual(["1.0s", "1.2s+200ms", "500ms−500ms"]);
  });

  it("separates groups with a rule, and none between a group's lines", () => {
    mount();
    const [first, middle, last] = linesOf(caseGroup("Ticket 2"));
    const edges = (line: HTMLTableRowElement) => [...line.cells].map((c) => c.className);
    for (const line of [first, middle]) {
      const own = [...line.cells].filter((c) => c.rowSpan === 1);
      expect(own.every((c) => c.className.includes("!border-b-0"))).toBe(true);
    }
    expect(edges(last).every((c) => c.includes("!border-border"))).toBe(true);
    // The cells spanning the group draw its rule from the first line.
    const spanning = [...first.cells].filter((c) => c.rowSpan > 1);
    expect(spanning.length).toBe(2);
    expect(spanning.every((c) => c.className.includes("!border-border"))).toBe(true);
  });
});

describe("CompareRunsView — a run without values", () => {
  it("says once, across the metric columns, that a run's task failed", () => {
    mount();
    const group = caseGroup("Ticket 6");
    const failed = cellAt(group, CANDIDATE_RUN.id, QUALITY);
    expect(cellAt(group, CANDIDATE_RUN.id, POLICY)).toBe(failed);
    expect(cellAt(group, CANDIDATE_RUN.id, ROUTE)).toBe(failed);
    expect(failed.colSpan).toBe(3);
    expect(shownText(failed)).toBe("Task error·Upstream timeout");
    // Its latency and cost were still recorded, and its output stays in its column.
    expect(shownText(cellAt(group, CANDIDATE_RUN.id, "Latency"))).toBe("1.2s+200ms");
    expect(shownText(cellAt(group, CANDIDATE_RUN.id, "Output"))).toBe("run-2 output");
    expect(within(lineOf(group, CANDIDATE_RUN.id)).getAllByText("Task error")).toHaveLength(1);
  });

  it("says once that a run has no result for the case, in its output's place", () => {
    mount();
    for (const [input, runId] of [
      ["Ticket 9", CANDIDATE_RUN.id],
      ["Ticket 10", BASELINE_RUN.id],
    ]) {
      const group = caseGroup(input);
      const line = lineOf(group, runId);
      expect(shownText(cellAt(group, runId, "Output"))).toBe("No result in this run");
      expect(within(line).getAllByText(/No result/)).toHaveLength(1);
      // Metrics, latency and cost are one empty cell.
      const rest = cellAt(group, runId, QUALITY);
      expect(cellAt(group, runId, "Cost")).toBe(rest);
      expect(rest.colSpan).toBe(5);
      expect(shownText(rest)).toBe("");
    }
  });

  it("keeps a scorer's own error, or a scorer that recorded nothing, in its column", () => {
    mount();
    expect(columnTexts(caseGroup("Ticket 7"), QUALITY)).toEqual([
      "85.0%",
      "Scorer error",
      "80.0%−5.0 pp",
    ]);
    expect(columnTexts(caseGroup("Ticket 7"), POLICY)).toEqual(["0", "0", "0"]);
    expect(columnTexts(caseGroup("Ticket 8"), QUALITY)).toEqual([
      "85.0%",
      "Not scored",
      "80.0%−5.0 pp",
    ]);
  });
});

describe("CompareRunsView — a search that picks no case", () => {
  it("says so in one row across all the table's columns", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "no case has this text" },
    });
    expect(caseGroups()).toHaveLength(0);
    const message = screen.getByText("No cases match the search or filters");
    const body = message.closest("tbody") as HTMLElement;
    expect(body.querySelectorAll("tr")).toHaveLength(1);
    const columns = within(screen.getAllByRole("table")[0]).getAllByRole("columnheader").length;
    expect(message.closest("td")?.colSpan).toBe(columns);
    // A search alone: the way out is named for what it clears.
    expect(within(body).getByRole("button", { name: "Clear search" })).toBeTruthy();
  });
});

describe("CompareRunsView — a run with no latency or cost", () => {
  it("reads an unrecorded latency or cost as a dash, never zero", () => {
    const unrecorded = (r: (typeof PAIRED_FIXTURE)[number]["results"][number]) =>
      r.runId === CANDIDATE_RUN.id && r.testCaseId === "case-3"
        ? { ...r, durationMs: null, cost: null }
        : r;
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => {
        const bundle = PAIRED_FIXTURE.find((b) => b.run.id === id);
        return {
          data: bundle && { ...bundle, results: bundle.results.map(unrecorded) },
          isLoading: false,
          isError: false,
        };
      }),
    );
    mount();
    const group = caseGroup("Ticket 3");
    expect(shownText(cellAt(group, CANDIDATE_RUN.id, "Latency"))).toBe("—");
    expect(shownText(cellAt(group, CANDIDATE_RUN.id, "Cost"))).toBe("—");
    // The runs that did record a latency still show it.
    expect(shownText(cellAt(group, BASELINE_RUN.id, "Latency"))).toBe("1.0s");
  });
});

describe("CompareRunsView — a group as one target", () => {
  it("highlights the whole group on hover", () => {
    mount();
    expect(caseGroup("Ticket 2").className).toContain("hover:bg-muted");
  });

  it("opens the case on the run of the line clicked, and the baseline's line on the default pair", () => {
    const onInspect = mount();
    const group = caseGroup("Ticket 2");
    fireEvent.click(cellAt(group, FAST_RUN.id, "Latency"));
    fireEvent.click(cellAt(group, BASELINE_RUN.id, QUALITY));
    expect(onInspect.mock.calls).toEqual([
      [{ caseToken: "id:case-2", pair: [BASELINE_RUN.id, FAST_RUN.id] }],
      // Nothing has been shown yet, so the first run after the baseline.
      [{ caseToken: "id:case-2", pair: [BASELINE_RUN.id, CANDIDATE_RUN.id] }],
    ]);
  });

  it("makes each group one tab stop, its first line, opened with Enter", () => {
    const onInspect = mount();
    const group = caseGroup("Ticket 2");
    const [first, ...rest] = linesOf(group);
    expect(first.tabIndex).toBe(0);
    expect(first.dataset.row).toBeDefined();
    expect(rest.every((line) => !line.hasAttribute("tabindex"))).toBe(true);
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "Enter" });
    expect(onInspect).toHaveBeenLastCalledWith({
      caseToken: "id:case-2",
      pair: [BASELINE_RUN.id, CANDIDATE_RUN.id],
    });
    // A key on another line's content is not the group's own.
    fireEvent.keyDown(rest[0], { key: "Enter" });
    expect(onInspect).toHaveBeenCalledTimes(1);
  });

  it("opens the focused group with Space too", () => {
    const onInspect = mount();
    const [first] = linesOf(caseGroup("Ticket 3"));
    act(() => first.focus());
    fireEvent.keyDown(first, { key: " " });
    expect(onInspect).toHaveBeenLastCalledWith({
      caseToken: "id:case-3",
      pair: [BASELINE_RUN.id, CANDIDATE_RUN.id],
    });
  });

  it("marks the open case's group", () => {
    render(
      <CompareRunsView
        projectId="p1"
        runIds={RUN_IDS}
        baselineId={null}
        onChangeBaseline={vi.fn()}
        onChangeRuns={vi.fn()}
        inspected={{ caseToken: "id:case-2", pair: null }}
        onInspect={vi.fn()}
      />,
    );
    const group = caseGroup("Ticket 2");
    expect(group.dataset.selected).toBe("true");
    expect(linesOf(group)[0].getAttribute("aria-current")).toBe("true");
    expect(caseGroup("Ticket 3").dataset.selected).toBeUndefined();
  });
});

describe("CompareRunsView — the all-cases group", () => {
  it("leads the body as a group with one line per run, scrolling with the cases", () => {
    mount();
    const summary = summaryGroup();
    expect(document.querySelector("tbody")).toBe(summary);
    expect(summary.closest("thead")).toBeNull();
    expect(document.querySelectorAll("thead tr")).toHaveLength(1);
    expect(shownText(cellAt(summary, BASELINE_RUN.id, "Input"))).toBe("All cases");
    expect(linesOf(summary).map((l) => l.dataset.runId)).toEqual(RUN_IDS);
    expect(columnTexts(summary, "Run")).toEqual(["#1", "#2", "#3"]);
    // A summary, not a case: no line of it is a tab stop that opens a case.
    expect(summary.querySelector("tr[tabindex], tr[data-row]")).toBeNull();
  });

  it("shows each candidate's paired means and change, then n and its counts", () => {
    mount();
    const quality = cellAt(summaryGroup(), CANDIDATE_RUN.id, QUALITY);
    expect(shownText(quality)).toBe("78.6% → 82.1%+3.6 ppn=7↗ 6↘ 1");
    const sub = within(quality).getByText("n=7").closest(".text-muted-foreground");
    expect(sub?.className).toContain("text-[11px]");
    expect(within(quality).getByLabelText("6 improved, 1 regressed vs baseline")).toBeTruthy();
    expect(shownText(cellAt(summaryGroup(), CANDIDATE_RUN.id, "Latency"))).toBe(
      "1.0s → 1.2s+200msn=10",
    );
  });

  it("labels the baseline's line, leaving its numbers to each candidate's line", () => {
    mount();
    const baseline = (header: string) => shownText(cellAt(summaryGroup(), BASELINE_RUN.id, header));
    const label = cellAt(summaryGroup(), BASELINE_RUN.id, "Output");
    expect(shownText(label)).toBe("Baseline");
    expect(lineOf(summaryGroup(), BASELINE_RUN.id).className).toContain("text-muted-foreground");
    // Each candidate's line reads "baseline → candidate" for its own pair, so the baseline's
    // line repeats no number, even where every pair reads the baseline the same.
    for (const header of [POLICY, QUALITY, ROUTE, "Latency", "Cost"]) {
      expect(baseline(header)).toBe("");
    }
    expect(within(lineOf(summaryGroup(), BASELINE_RUN.id)).queryByText("—")).toBeNull();
    // The candidates' lines leave their Output cell empty.
    expect(shownText(cellAt(summaryGroup(), CANDIDATE_RUN.id, "Output"))).toBe("");
  });

  it("filters the table from a candidate's counts", () => {
    mount();
    fireEvent.click(
      within(summaryGroup()).getByRole("button", {
        name: "Show 1 case where #2 regressed on quality",
      }),
    );
    expect(caseGroups()).toHaveLength(1);
    expect(shownText(cellAt(summaryGroup(), BASELINE_RUN.id, "Input"))).toBe("Matching cases");
  });
});

describe("CompareRunsView — a scorer another run records as text", () => {
  it("shows a numeric pair's change on its line, as its summary does", () => {
    // Bare `{ name, version }` scorers, so each value type comes from what was recorded:
    // numbers in the baseline and #2, text in #3.
    const bundles = ([0.4, 0.8, "high"] as const).map((value, i) => {
      const id = RUN_IDS[i];
      return {
        run: fixtureRun(id, i + 1, id, `2026-11-0${i + 1}T00:00:00Z`, {
          scorers: scorerManifest([{ name: QUALITY, version: "1" }]),
        }),
        results: [fixtureResult(id, "tc-1", "one", [fixtureScore(QUALITY, value)])],
      };
    });
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: bundles.find((b) => b.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    mount();
    const group = caseGroup("one");
    const change = within(cellAt(group, CANDIDATE_RUN.id, QUALITY)).getByText("+0.4");
    expect(change.className).toContain("text-emerald-600");
    expect(shownText(cellAt(group, CANDIDATE_RUN.id, QUALITY))).not.toContain("changed");
    // The run that recorded text still reads as a value type change, not a change.
    expect(shownText(cellAt(group, FAST_RUN.id, QUALITY))).not.toContain("+");
  });
});

describe("CompareRunsView — pinned while scrolling", () => {
  it("pins the label row, the Input column and the Run column", () => {
    mount();
    const labels = document.querySelector("thead tr") as HTMLTableRowElement;
    expect(labels.className).toContain("row-sticky-top");
    const [input, run] = [...labels.cells];
    expect(shownText(input)).toBe("Input");
    expect(input.className).toContain("col-sticky-start");
    expect(shownText(run)).toBe("Run");
    expect(run.className).toContain("left-[240px]");
    const group = caseGroup("Ticket 2");
    expect(cellAt(group, BASELINE_RUN.id, "Input").className).toContain("col-sticky-start");
    for (const runId of RUN_IDS) {
      const cell = cellAt(group, runId, "Run");
      expect(cell.className).toContain("sticky");
      expect(cell.className).toContain("left-[240px]");
    }
  });
});
