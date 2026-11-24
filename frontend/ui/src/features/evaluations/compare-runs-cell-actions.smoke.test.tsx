// @vitest-environment jsdom
/**
 * A long field in the comparison table can be copied or opened from its own cell. While a
 * text value (Input, each run's Output, Expected) is hovered or holds focus it shows two
 * small buttons: Copy, which copies that run's full text, and Open in trace panel, which
 * opens the case on that run (or on the default pair, from Input and Expected). They are
 * real buttons, reached by keyboard, and using one never opens the row as well. Clipped
 * text keeps its hover tooltip; wrapped text, already shown in full, has none. A case's
 * group of lines builds its controls only while it is hovered or holds focus, and its text
 * stays the same nodes as they come and go, so a quick click on it or a selection across
 * rows holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fixtureResult, fixtureRun, fixtureScore } from "./compare/__tests__/paired-fixture";
import type { RunBundle } from "./compare/model";
import { caseGroup } from "./compare/__tests__/table-grid";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
vi.mock("./hooks", () => hooks);
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
  const pending = { data: undefined, isLoading: true, isFetching: true, isError: false };
  return { ...actual, useTrace: () => ({ ...pending, refetch: vi.fn() }) };
});

import { CompareRunsView } from "./views/compare-runs-view";

const LONG_OUTPUT =
  '  {"answer": "Open Settings, then Security, then Single sign-on, and press Reset.",\n  "steps": 3}\n';

const result = (runId: string, n: number, overrides = {}) =>
  fixtureResult(runId, `case-${n}`, `Ticket ${n}`, [fixtureScore("quality", 0.9)], {
    expectedOutput: n === 1 ? "Reset SSO from Security settings" : null,
    candidateOutput: `${runId} answer ${n}`,
    ...overrides,
  });

// Three runs of one dataset. Case 1: #2's output is long and spans lines. Case 2: #2's
// task failed, so it has an error where its output would be. Case 3: each run has its own
// wording of the input and its own expected output, so both columns stack per run.
const reworded = (runId: string, wording: string) =>
  result(runId, 3, { input: `Ticket 3${wording}`, expectedOutput: `Route${wording}` });
const BUNDLES: RunBundle[] = [
  {
    run: fixtureRun("run-1", 1, "baseline-v1", "2026-11-01T10:00:00.000Z"),
    results: [result("run-1", 1), result("run-1", 2), reworded("run-1", "")],
  },
  {
    run: fixtureRun("run-2", 2, "candidate-v2", "2026-11-02T10:00:00.000Z"),
    results: [
      result("run-2", 1, { candidateOutput: LONG_OUTPUT }),
      result("run-2", 2, {
        status: "errored",
        taskError: "Upstream timeout",
        candidateOutput: null,
      }),
      reworded("run-2", ", reworded"),
    ],
  },
  {
    run: fixtureRun("run-3", 3, "fast-v3", "2026-11-03T10:00:00.000Z"),
    results: [result("run-3", 1), result("run-3", 2), reworded("run-3", ", shortened")],
  },
];

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText } });
  writeText.mockClear();
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: BUNDLES.find((b) => b.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const mount = () => {
  const onInspect = vi.fn();
  render(
    <CompareRunsView
      projectId="p1"
      runIds={["run-1", "run-2", "run-3"]}
      baselineId={null}
      onChangeBaseline={vi.fn()}
      onChangeRuns={vi.fn()}
      inspected={null}
      onInspect={onInspect}
    />,
  );
  return onInspect;
};

/** The case's group of lines. */
const rowOf = (input: string) => caseGroup(input);
/** The group's one tab stop: its first line. */
const tabStop = (group: HTMLElement) => group.querySelector("tr") as HTMLElement;
/** The case's group, hovered, so its tooltips and controls are there. */
const caseRow = (input: string) => {
  const row = rowOf(input);
  fireEvent.mouseEnter(row);
  return row;
};
const control = (row: HTMLElement, name: string) => within(row).getByRole("button", { name });

describe("CompareRunsView — copy or open a field from its cell", () => {
  it("copies a run's full output, as recorded, without opening the case", async () => {
    const onInspect = mount();
    const row = caseRow("Ticket 1");
    fireEvent.click(control(row, "Copy #2 output"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(LONG_OUTPUT));
    fireEvent.click(control(row, "Copy expected output"));
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("Reset SSO from Security settings"),
    );
    fireEvent.click(control(row, "Copy input"));
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Ticket 1"));
    expect(onInspect).not.toHaveBeenCalled();
  });

  it("opens the case on the run whose output it is", () => {
    const onInspect = mount();
    const row = caseRow("Ticket 1");
    fireEvent.click(control(row, "Open #3 output in the trace panel"));
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(onInspect).toHaveBeenLastCalledWith({
      caseToken: "id:case-1",
      pair: ["run-1", "run-3"],
    });
  });

  it("opens the default pair from Input and Expected", () => {
    const onInspect = mount();
    const row = caseRow("Ticket 1");
    fireEvent.click(control(row, "Open input in the trace panel"));
    fireEvent.click(control(row, "Open expected output in the trace panel"));
    expect(onInspect.mock.calls).toEqual([
      [{ caseToken: "id:case-1", pair: ["run-1", "run-2"] }],
      [{ caseToken: "id:case-1", pair: ["run-1", "run-2"] }],
    ]);
  });

  it("opens the default pair from the baseline's own output", () => {
    const onInspect = mount();
    const row = caseRow("Ticket 1");
    fireEvent.click(control(row, "Open #1 output in the trace panel"));
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(onInspect).toHaveBeenLastCalledWith({
      caseToken: "id:case-1",
      pair: ["run-1", "run-2"],
    });
  });

  it("opens a stacked input or expected output on the run it belongs to", () => {
    const onInspect = mount();
    const row = caseRow("Ticket 3, shortened");
    fireEvent.click(control(row, "Open #3 input in the trace panel"));
    fireEvent.click(control(row, "Open #3 expected output in the trace panel"));
    expect(onInspect.mock.calls).toEqual([
      [{ caseToken: "id:case-3", pair: ["run-1", "run-3"] }],
      [{ caseToken: "id:case-3", pair: ["run-1", "run-3"] }],
    ]);
  });

  it("keeps each value's controls outside its clipped text, filled like the row", () => {
    mount();
    const row = caseRow("Ticket 1");
    // A clipped run value hides its overflow; the controls sit beside it, not inside it.
    const copy = control(row, "Copy #2 output");
    expect(copy.closest(".truncate")).toBeNull();
    // The controls take the row's fill (plain, hovered or open) rather than their own.
    expect(row.className).toContain("group/row");
    const chip = copy.parentElement as HTMLElement;
    expect(chip.className).toContain("group-hover/row:bg-muted");
    expect(chip.className).toContain("group-data-[selected=true]/row:bg-accent");
  });

  it("is reached by keyboard, and a key on it never opens the row", () => {
    const onInspect = mount();
    const row = rowOf("Ticket 1");
    // Focus on the group, not a hover, puts its controls in the tab order after it.
    act(() => tabStop(row).focus());
    const copy = control(row, "Copy #2 output");
    expect(copy.tagName).toBe("BUTTON");
    expect(copy.tabIndex).toBe(0);
    copy.focus();
    expect(document.activeElement).toBe(copy);
    // Shown while the field holds focus, not only on hover.
    expect(copy.parentElement?.className).toContain("group-focus-within/field:opacity-100");
    fireEvent.keyDown(copy, { key: "Enter" });
    fireEvent.keyDown(copy, { key: " " });
    expect(onInspect).not.toHaveBeenCalled();
  });

  it("offers nothing where a run has no text", () => {
    mount();
    const row = caseRow("Ticket 2");
    expect(within(row).getByText("Task error")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Copy #2 output" })).toBeNull();
    // No expected output on this case.
    expect(within(row).queryByRole("button", { name: "Copy expected output" })).toBeNull();
    expect(control(row, "Copy #3 output")).toBeTruthy();
  });

  it("builds a row's controls only while it is hovered or holds focus", () => {
    mount();
    const row = rowOf("Ticket 1");
    expect(within(row).queryByRole("button", { name: "Copy #2 output" })).toBeNull();

    fireEvent.mouseEnter(row);
    expect(control(row, "Copy #2 output")).toBeTruthy();
    // A tooltip's content is built only once it opens.
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseLeave(row);
    expect(within(row).queryByRole("button", { name: "Copy #2 output" })).toBeNull();

    // Focus moving into the row's controls keeps them; focus leaving the row drops them.
    act(() => tabStop(row).focus());
    act(() => control(row, "Copy #2 output").focus());
    expect(document.activeElement).toBe(control(row, "Copy #2 output"));
    act(() => tabStop(rowOf("Ticket 2")).focus());
    expect(within(row).queryByRole("button", { name: "Copy #2 output" })).toBeNull();
  });

  it.each(["clip", "wrap"])(
    "keeps a row's text as the same nodes while its controls come and go (%s)",
    (text) => {
      window.localStorage.setItem(
        "traceroot:compare-display:p1",
        JSON.stringify({ density: "compact", text, hidden: [] }),
      );
      mount();
      const row = rowOf("Ticket 1");
      // The input every run shares, and one run's output.
      const input = within(row).getByText("Ticket 1");
      const output = within(row).getByText("run-3 answer 1");
      const unchanged = () => {
        expect(within(row).getByText("Ticket 1")).toBe(input);
        expect(within(row).getByText("run-3 answer 1")).toBe(output);
      };
      const controls = () => within(row).queryAllByRole("button", { name: /^(Copy|Open) / });

      fireEvent.mouseEnter(row);
      expect(controls().length).toBeGreaterThan(0);
      unchanged();
      fireEvent.mouseLeave(row);
      expect(controls()).toHaveLength(0);
      unchanged();
      act(() => tabStop(row).focus());
      expect(controls().length).toBeGreaterThan(0);
      unchanged();
      act(() => tabStop(rowOf("Ticket 2")).focus());
      expect(controls()).toHaveLength(0);
      unchanged();
    },
  );

  it("opens the case from a click that lands as the pointer enters the text", () => {
    const onInspect = mount();
    const row = rowOf("Ticket 1");
    // The pointer comes in and clicks at once, so every event lands on the text it entered.
    const quickClick = (el: HTMLElement) => {
      fireEvent.mouseEnter(el);
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el);
      fireEvent.mouseLeave(row);
    };
    quickClick(within(row).getByText("run-3 answer 1"));
    quickClick(within(row).getByText("Ticket 1"));
    expect(onInspect.mock.calls).toEqual([
      [{ caseToken: "id:case-1", pair: ["run-1", "run-3"] }],
      [{ caseToken: "id:case-1", pair: ["run-1", "run-2"] }],
    ]);
  });

  it("keeps the hover tooltip for clipped text only", async () => {
    mount();
    const output = within(caseRow("Ticket 1")).getByText("run-3 answer 1");
    fireEvent.focus(output);
    expect(within(await screen.findByRole("tooltip")).getByText("run-3 answer 1")).toBeTruthy();
    cleanup();

    window.localStorage.setItem(
      "traceroot:compare-display:p1",
      JSON.stringify({ density: "compact", text: "wrap", hidden: [] }),
    );
    mount();
    const row = caseRow("Ticket 1");
    fireEvent.focus(within(row).getByText("run-3 answer 1"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(control(row, "Copy #3 output")).toBeTruthy();
    expect(control(row, "Open #3 output in the trace panel")).toBeTruthy();
  });
});
