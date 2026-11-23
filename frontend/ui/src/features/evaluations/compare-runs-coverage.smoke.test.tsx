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
    />,
  );
}

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
