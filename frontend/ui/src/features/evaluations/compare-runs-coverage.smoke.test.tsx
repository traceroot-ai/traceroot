// @vitest-environment jsdom
/**
 * Which cases the run comparison page shows, and what it says about the ones a run is
 * missing, on three runs of one 12-case dataset (see `compare/__tests__/paired-fixture.ts`):
 * #1 has no case 10 and #2 has no case 9, so only 10 cases are in every run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, within, fireEvent } from "@testing-library/react";
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
import type { RunBundle } from "./compare/model";
import {
  caseGroup,
  caseGroups,
  cellAt,
  columnTexts,
  lineOf,
  shownText,
} from "./compare/__tests__/table-grid";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
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
});
afterEach(() => cleanup());

const mount = () =>
  render(
    <CompareRunsView
      projectId="p1"
      runIds={RUN_IDS}
      baselineId={null}
      onChangeBaseline={vi.fn()}
      onChangeRuns={vi.fn()}
    />,
  );

const caseRow = (input: string) => caseGroup(input);
const bodyRows = caseGroups;

describe("CompareRunsView — every case", () => {
  it("lists every case any run has, in the baseline's order", () => {
    mount();
    expect(bodyRows()).toHaveLength(12);
    // The baseline's 11 cases first, then the case only the other runs have.
    expect(bodyRows()[0].textContent).toContain("Ticket 1");
    expect(bodyRows()[11].textContent).toContain("Ticket 10");
  });

  it("says once on a run's line that it has no result for the case", () => {
    mount();
    // Lines run baseline first: #1, #2, #3.
    const missingFromBaseline = caseRow("Ticket 10");
    expect(columnTexts(missingFromBaseline, "Output")).toEqual([
      "No result in this run",
      "run-2 output",
      "run-3 output",
    ]);
    expect(
      within(lineOf(missingFromBaseline, BASELINE_RUN.id)).getAllByText(/No result/),
    ).toHaveLength(1);
    const missingFromCandidate = caseRow("Ticket 9");
    expect(columnTexts(missingFromCandidate, QUALITY)).toEqual(["85.0%", "", "80.0%−5.0 pp"]);
    expect(within(caseRow("Ticket 1")).queryByText(/No result/)).toBeNull();
  });

  it("shows a case's input once when the runs that have it agree on it", () => {
    mount();
    expect(within(caseRow("Ticket 10")).getAllByText("Ticket 10")).toHaveLength(1);
  });

  it("says how many cases every run has, and how many only some runs have", () => {
    mount();
    expect(screen.getByText("12 cases · 10 in all runs")).toBeTruthy();
  });
});

/** Mount `runs`, selected in this order, the first the baseline. */
function mountRuns(runs: RunBundle[]) {
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: runs.find((x) => x.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
  render(
    <CompareRunsView
      projectId="p1"
      runIds={runs.map((b) => b.run.id)}
      baselineId={runs[0].run.id}
      onChangeBaseline={vi.fn()}
      onChangeRuns={vi.fn()}
    />,
  );
}

const bundleOf = (runId: string) => PAIRED_FIXTURE.find((b) => b.run.id === runId)!;

describe("CompareRunsView — expected output", () => {
  const expecting = (runId: string, expectedOutput: string) =>
    fixtureResult(runId, "case-1", "Ticket 1", [fixtureScore(QUALITY, 0.9)], { expectedOutput });

  it("shows it once when the runs record the same one in different forms", () => {
    mountRuns([
      { run: BASELINE_RUN, results: [expecting(BASELINE_RUN.id, '{"route": "billing"}')] },
      { run: CANDIDATE_RUN, results: [expecting(CANDIDATE_RUN.id, '{"route":"billing"}')] },
    ]);
    expect(shownText(cellAt(caseRow("Ticket 1"), BASELINE_RUN.id, "Expected"))).toBe(
      '{"route": "billing"}',
    );
  });

  it("shows each run's when they expect different outputs", () => {
    mountRuns([
      { run: BASELINE_RUN, results: [expecting(BASELINE_RUN.id, '{"route": "billing"}')] },
      { run: CANDIDATE_RUN, results: [expecting(CANDIDATE_RUN.id, '{"route": "sales"}')] },
    ]);
    expect(shownText(cellAt(caseRow("Ticket 1"), BASELINE_RUN.id, "Expected"))).toBe(
      '{"route": "billing"}{"route": "sales"}',
    );
  });
});

/** Mount two runs of one case each, `a` the baseline. */
function mountPair(a: RunBundle["results"], b: RunBundle["results"]) {
  const runs: RunBundle[] = [
    { run: fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z"), results: a },
    { run: fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z"), results: b },
  ];
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: runs.find((x) => x.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
  render(
    <CompareRunsView
      projectId="p1"
      runIds={["a", "b"]}
      baselineId="a"
      onChangeBaseline={vi.fn()}
      onChangeRuns={vi.fn()}
    />,
  );
}

describe("CompareRunsView — cells without a value", () => {
  it("tells a task error, a scorer error and an unscored case apart", () => {
    mount();
    // #2: case 6 timed out in the task, case 7's judge timed out, case 8 was never scored.
    // #3 still shows its change against #1 on each.
    expect(columnTexts(caseRow("Ticket 6"), QUALITY)).toEqual([
      "85.0%",
      "Task error·Upstream timeout",
      "80.0%−5.0 pp",
    ]);
    expect(columnTexts(caseRow("Ticket 7"), QUALITY)).toEqual([
      "85.0%",
      "Scorer error",
      "80.0%−5.0 pp",
    ]);
    expect(columnTexts(caseRow("Ticket 8"), QUALITY)).toEqual([
      "85.0%",
      "Not scored",
      "80.0%−5.0 pp",
    ]);
    // The judge's failure is only that scorer's: the case's other scorers kept their values.
    expect(columnTexts(caseRow("Ticket 7"), POLICY)).toEqual(["0", "0", "0"]);
  });

  it("says why a task failed on its line, in full on hover", async () => {
    mount();
    const failed = cellAt(caseRow("Ticket 6"), CANDIDATE_RUN.id, QUALITY);
    fireEvent.focus(within(failed).getByText("Upstream timeout"));
    expect(within(await screen.findByRole("tooltip")).getByText("Upstream timeout")).toBeTruthy();
  });

  it("labels a failed task's output when a scorer still recorded a value", async () => {
    const failed = fixtureResult("b", "tc-1", "Ticket 1", [fixtureScore(QUALITY, 0.4)], {
      status: "errored",
      taskError: "Upstream timeout",
      candidateOutput: null,
    });
    mountPair([fixtureResult("a", "tc-1", "Ticket 1", [fixtureScore(QUALITY, 0.5)])], [failed]);
    const output = cellAt(caseRow("Ticket 1"), "b", "Output");
    expect(shownText(output)).toBe("Task error");
    expect(columnTexts(caseRow("Ticket 1"), QUALITY)).toEqual(["50.0%", "40.0%−10.0 pp"]);
    fireEvent.focus(within(output).getByText("Task error"));
    expect(within(await screen.findByRole("tooltip")).getByText("Upstream timeout")).toBeTruthy();
  });

  it("shows why a scorer failed on hover", async () => {
    mount();
    fireEvent.focus(
      within(cellAt(caseRow("Ticket 7"), CANDIDATE_RUN.id, QUALITY)).getByText("Scorer error"),
    );
    expect(within(await screen.findByRole("tooltip")).getByText("judge timed out")).toBeTruthy();
  });

  it("marks a value scored by another scorer version instead of comparing it", () => {
    mountPair(
      [fixtureResult("a", "tc-1", "Ticket 1", [fixtureScore(QUALITY, 0.5)])],
      [
        fixtureResult("b", "tc-1", "Ticket 1", [
          { ...fixtureScore(QUALITY, 0.7), scorerVersion: "2" },
        ]),
      ],
    );
    const quality = cellAt(caseRow("Ticket 1"), "b", QUALITY);
    expect(within(quality).getByText("70.0%")).toBeTruthy();
    expect(within(quality).getByText("Version mismatch")).toBeTruthy();
    expect(quality.textContent).not.toContain("pp");
  });

  it("marks a value of another kind than the baseline's instead of comparing it", () => {
    mountPair(
      [fixtureResult("a", "tc-1", "Ticket 1", [fixtureScore(QUALITY, 0.5)])],
      [fixtureResult("b", "tc-1", "Ticket 1", [fixtureScore(QUALITY, "high")])],
    );
    const quality = cellAt(caseRow("Ticket 1"), "b", QUALITY);
    expect(within(quality).getByText("high")).toBeTruthy();
    expect(within(quality).getByText("Type mismatch")).toBeTruthy();
  });

  it("says on hover why a mismatched value isn't compared", async () => {
    mountPair(
      [fixtureResult("a", "tc-1", "Ticket 1", [fixtureScore(QUALITY, 0.5)])],
      [
        fixtureResult("b", "tc-1", "Ticket 1", [
          { ...fixtureScore(QUALITY, 0.7), scorerVersion: "2" },
        ]),
      ],
    );
    const quality = cellAt(caseRow("Ticket 1"), "b", QUALITY);
    fireEvent.focus(within(quality).getByText("Version mismatch"));
    expect(
      within(await screen.findByRole("tooltip")).getByText(
        "This run and the baseline used different versions of this scorer, so the values aren’t compared.",
      ),
    ).toBeTruthy();
  });

  it("shows the value and change the comparison used when a scorer recorded twice", () => {
    // The candidate's newer scorer version re-scored the case; the comparison reads that
    // row, so the cell must too (not the first row it happens to list).
    mountPair(
      [
        fixtureResult("a", "tc-1", "Ticket 1", [
          { ...fixtureScore(QUALITY, 0.5), scorerVersion: "2" },
        ]),
      ],
      [
        fixtureResult("b", "tc-1", "Ticket 1", [
          { ...fixtureScore(QUALITY, 0.9), scorerVersion: "1" },
          { ...fixtureScore(QUALITY, 0.6), scorerVersion: "2" },
        ]),
      ],
    );
    expect(columnTexts(caseRow("Ticket 1"), QUALITY)).toEqual(["50.0%", "60.0%+10.0 pp"]);
  });

  it("shows a categorical scorer's numbers as labels, without a difference", () => {
    const scorers = scorerManifest([{ name: "tier", version: "1", value_type: "categorical" }]);
    const runs: RunBundle[] = [
      {
        run: fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z", { scorers }),
        results: [fixtureResult("a", "tc-1", "Ticket 1", [fixtureScore("tier", 1)])],
      },
      {
        run: fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z", { scorers }),
        results: [fixtureResult("b", "tc-1", "Ticket 1", [fixtureScore("tier", 2)])],
      },
    ];
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: runs.find((x) => x.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    render(
      <CompareRunsView
        projectId="p1"
        runIds={["a", "b"]}
        baselineId="a"
        onChangeBaseline={vi.fn()}
        onChangeRuns={vi.fn()}
      />,
    );
    // 1 → 2 is a different label, not "+1".
    expect(columnTexts(caseRow("Ticket 1"), "tier")).toEqual(["1", "2changed"]);
  });

  it("marks a categorical value that changed from the baseline's, without colour", () => {
    mount();
    // #2 routes case 12 to "refunds"; #1 and #3 route it to "billing".
    expect(columnTexts(caseRow("Ticket 12"), ROUTE)).toEqual([
      "billing",
      "refundschanged",
      "billing",
    ]);
    const marker = within(caseRow("Ticket 12")).getByText("changed");
    expect(marker.className).toContain("text-muted-foreground");
    expect(marker.className).not.toMatch(/text-(emerald|red)-/);
    expect(within(caseRow("Ticket 1")).queryByText("changed")).toBeNull();
  });
});

describe("CompareRunsView — a run that shares no case with the others", () => {
  it("still compares the runs that do share cases when one run has no results", () => {
    mountRuns([
      bundleOf(BASELINE_RUN.id),
      bundleOf(CANDIDATE_RUN.id),
      { run: { ...FAST_RUN, caseCount: 12 }, results: [] },
    ]);
    expect(bodyRows()).toHaveLength(12);
    expect(screen.getByText("#3 has no results.")).toBeTruthy();
    // #2's change against #1 is still shown; #3 has nothing in any per-run column.
    expect(columnTexts(caseRow("Ticket 2"), QUALITY)).toEqual(["85.0%", "30.0%−55.0 pp", ""]);
    expect(within(caseRow("Ticket 2")).getAllByText("No result in this run")).toHaveLength(1);
  });

  it("still compares the runs that do share cases when one run is on an unrelated dataset", () => {
    const other = fixtureRun("run-x", 7, "other-v7", "2026-11-04T10:00:00.000Z", {
      datasetId: "ds2",
      datasetName: "refunds",
    });
    mountRuns([
      bundleOf(BASELINE_RUN.id),
      bundleOf(CANDIDATE_RUN.id),
      { run: other, results: [fixtureResult("run-x", "r-1", "Refund 1", [])] },
    ]);
    expect(screen.queryByText(/share no/)).toBeNull();
    expect(bodyRows()).toHaveLength(13);
    expect(columnTexts(caseRow("Ticket 2"), QUALITY)).toEqual(["85.0%", "30.0%−55.0 pp", ""]);
  });

  it("says which run has no results when no two runs share a case", () => {
    mountRuns([bundleOf(BASELINE_RUN.id), { run: CANDIDATE_RUN, results: [] }]);
    expect(screen.getByText("#2 has no results.")).toBeTruthy();
    expect(screen.queryByText(/share no/)).toBeNull();
    expect(bodyRows()).toHaveLength(0);
  });
});

describe("CompareRunsView — runs with fewer results than cases", () => {
  /** Mount the fixture with each run's declared case count set by `caseCount`. */
  const mountDeclaring = (caseCount: (b: RunBundle) => Partial<RunBundle["run"]>) => {
    const runs = PAIRED_FIXTURE.map((b) => ({ ...b, run: { ...b.run, ...caseCount(b) } }));
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: runs.find((x) => x.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    mount();
  };

  it("says which run reported fewer cases than it declared, without blaming a limit", () => {
    // #2 declared 12 cases and reported 11; the run read flags it as truncated.
    mountDeclaring((b) =>
      b.run.id === CANDIDATE_RUN.id
        ? { caseCount: 12, resultsTruncated: true }
        : { caseCount: b.results.length, resultsTruncated: false },
    );
    expect(screen.getByText("#2 reported 11 of 12 cases.")).toBeTruthy();
    expect(screen.queryByText(/limit/i)).toBeNull();
    expect(screen.queryByText(/partial/i)).toBeNull();
  });

  it("folds several short runs into one line, with each run's reason on hover", async () => {
    // #1 and #2 each declared 12 cases and reported 11.
    mountDeclaring((b) => ({ caseCount: 12, resultsTruncated: b.results.length < 12 }));
    const line = screen.getByText("2 runs are missing cases");
    expect(screen.queryByText("#2 reported 11 of 12 cases.")).toBeNull();
    fireEvent.focus(line);
    const tip = within(await screen.findByRole("tooltip"));
    expect(tip.getByText("#1 reported 11 of 12 cases.")).toBeTruthy();
    expect(tip.getByText("#2 reported 11 of 12 cases.")).toBeTruthy();
  });

  it("lists two runs' notes on hover when their evaluations share a name", async () => {
    // An evaluation named "support-routing (2)" and a second one named "support-routing":
    // each run keeps its own tag, so each gets its own note, and no two notes share a key.
    const empty = (id: string, evaluationId: string, evaluationName: string, day: string) => ({
      run: fixtureRun(id, 1, `${id}-v1`, `2026-11-${day}T10:00:00.000Z`, {
        evaluationId,
        evaluationName,
        caseCount: 12,
      }),
      results: [],
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mountRuns([
        bundleOf(BASELINE_RUN.id),
        bundleOf(CANDIDATE_RUN.id),
        empty("run-b", "ev2", "support-routing", "05"),
        empty("run-c", "ev3", "support-routing (2)", "06"),
      ]);
      fireEvent.focus(screen.getByText("2 runs are missing cases"));
      const tip = within(await screen.findByRole("tooltip"));
      expect(tip.getByText("support-routing (2) #1 has no results.")).toBeTruthy();
      expect(tip.getByText("support-routing (3) #1 has no results.")).toBeTruthy();
      expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    } finally {
      error.mockRestore();
    }
  });

  it("says nothing more when every run reported every case it declared", () => {
    mountDeclaring((b) => ({ caseCount: b.results.length, resultsTruncated: false }));
    expect(screen.queryByText(/reported|loaded the first/)).toBeNull();
  });
});
