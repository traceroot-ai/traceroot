// @vitest-environment jsdom
/**
 * The N-run "Run Comparison" page: 2+ runs measured on the same dataset, lined up
 * by dataset-row id, one colour-keyed value per run stacked in each metric cell.
 * Asserts the scorer columns, the per-run stacked values, the baseline legend, that
 * Input collapses when the runs agree, and that the removed chrome (swap / main score
 * / status / filter tabs / verdict / row drill-in) is gone.
 *
 * Fixture: the ticket-routing lab (opus #41 baseline vs sonnet #42) sharing two
 * dataset rows; ticket-05 routes differently between the two runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
vi.mock("./hooks", () => hooks);

import { CompareRunsView } from "./views/compare-runs-view";

const SCORERS = ["routing_accuracy", "is_known_category"];

const score = (name: string, v: number) => ({
  id: `${name}-id`,
  scorerName: name,
  scorerVersion: "v1",
  numericValue: v,
  boolValue: null,
  stringValue: null,
  passed: null,
  explanation: null,
  error: null,
});

const result = (
  caseId: string,
  input: string,
  output: string,
  scores: { routing_accuracy: number; is_known_category: number },
) => ({
  id: `${caseId}-r`,
  runId: "r",
  evaluationId: "ev1",
  testCaseId: caseId,
  traceId: `tr-${caseId}`,
  input,
  expectedOutput: "billing",
  candidateOutput: output,
  baselineOutput: null,
  status: "passed",
  change: null,
  taskError: null,
  durationMs: 2100,
  cost: 0.01,
  createTime: "2026-07-26T10:00:00.000Z",
  scores: [
    score("routing_accuracy", scores.routing_accuracy),
    score("is_known_category", scores.is_known_category),
  ],
  comparison: null,
});

const FULL_COVERAGE = {
  mode: "full",
  datasetCaseCount: 2,
  selectedCaseCount: 2,
  sampleSeed: null,
} as const;

const runDetail = (id: string, runNumber: number, ver: string, over: object = {}) => ({
  id,
  runNumber,
  candidateVersion: ver,
  evaluationId: "ev1",
  evaluationName: "ticket-routing-quality",
  datasetId: "ds1",
  datasetName: "ticket-routing",
  datasetVersionId: "dv1",
  datasetVersionLabel: "v3",
  status: "completed",
  caseCount: 2,
  resultCount: 2,
  // Both runs measured the whole (2-case) dataset and nothing was capped, so the
  // default fixture carries no banner — the tests below add one deliberately.
  coverage: FULL_COVERAGE,
  resultsTruncated: false,
  ...over,
});

// Two shared rows; ticket-05 routes billing (opus) vs account_management (sonnet).
const OPUS = {
  run: runDetail("opus", 41, "opus"),
  results: [
    result("ticket-01", "Ticket 1: my invoice looks wrong", "billing", {
      routing_accuracy: 1,
      is_known_category: 1,
    }),
    result("ticket-05", "Ticket 5: my card was double-charged and I want a refund", "billing", {
      routing_accuracy: 1,
      is_known_category: 1,
    }),
  ],
};
const SONNET = {
  run: runDetail("sonnet", 42, "sonnet"),
  results: [
    result("ticket-01", "Ticket 1: my invoice looks wrong", "billing", {
      routing_accuracy: 1,
      is_known_category: 1,
    }),
    result(
      "ticket-05",
      "Ticket 5: my card was double-charged and I want a refund",
      "account_management",
      { routing_accuracy: 0, is_known_category: 1 },
    ),
  ],
};

const RESP: Record<string, unknown> = { opus: OPUS, sonnet: SONNET };

beforeEach(() => {
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({ data: RESP[id], isLoading: false, isError: false })),
  );
});
afterEach(() => cleanup());

const mount = (baselineId = "opus") =>
  render(
    <CompareRunsView
      projectId="p1"
      runIds={["opus", "sonnet"]}
      baselineId={baselineId}
      onChangeBaseline={vi.fn()}
    />,
  );

describe("CompareRunsView — N-run diff table", () => {
  it("renders one column per scorer", () => {
    mount();
    for (const s of SCORERS) {
      expect(screen.getAllByRole("columnheader", { name: new RegExp(s) }).length).toBeGreaterThan(
        0,
      );
    }
  });

  it("stacks each run's output in the row, and collapses a shared input to one value", () => {
    mount();
    const row = screen
      .getByText(/double-charged and I want a refund/)
      .closest("tr") as HTMLTableRowElement;
    // Both runs' outputs are shown (baseline billing, candidate account_management).
    expect(within(row).getByText("account_management")).toBeTruthy();
    expect(within(row).getAllByText("billing").length).toBeGreaterThan(0);
    // The input is identical across both runs → shown once (not once per run).
    expect(within(row).getAllByText(/double-charged and I want a refund/)).toHaveLength(1);
  });

  it("names the selected baseline in the picker", () => {
    mount("opus");
    // The baseline picker's trigger names the chosen baseline run.
    expect(screen.getAllByText(/#41 · opus/).length).toBeGreaterThan(0);
  });

  it("shows a regression delta against the baseline in the cells", () => {
    mount("opus");
    const row = screen
      .getByText(/double-charged and I want a refund/)
      .closest("tr") as HTMLTableRowElement;
    // sonnet routes ticket-05 wrong: routing_accuracy 0% vs baseline 100% → −100.0%.
    expect(within(row).getByText("−100.0%")).toBeTruthy();
  });

  it("filters rows by the search box", () => {
    mount();
    expect(screen.getByText(/my invoice looks wrong/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "double-charged" },
    });
    expect(screen.queryByText(/my invoice looks wrong/)).toBeNull();
    expect(screen.getByText(/double-charged/)).toBeTruthy();
  });

  it("has none of the removed chrome and no row drill-in", () => {
    mount();
    expect(screen.queryByRole("button", { name: /Swap/ })).toBeNull();
    expect(screen.queryByText("Main score")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Regressions/ })).toBeNull();
    expect(screen.queryByText("Regression")).toBeNull();
    // Rows are not interactive (drill-in postponed): no trace panel exists to open.
    fireEvent.click(screen.getByText(/double-charged and I want a refund/));
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  describe("coverage vs truncation", () => {
    /** Re-point the hook at a fixture whose sonnet run is overridden. */
    const withSonnetRun = (over: object) => {
      hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
        ids.map((id) => ({
          data: id === "sonnet" ? { ...SONNET, run: { ...SONNET.run, ...over } } : RESP[id],
          isLoading: false,
          isError: false,
        })),
      );
    };

    it("says nothing when both runs covered the whole dataset and nothing was capped", () => {
      mount();
      expect(screen.queryByText(/exploratory/)).toBeNull();
      expect(screen.queryByText(/API limit/)).toBeNull();
    });

    it("calls a subset comparison exploratory, and never blames the API for it", () => {
      // The user chose 20 of 500. Nothing was lost in transit, so the old "(API limit)"
      // wording was simply wrong. The baseline covered everything, so the two runs do
      // not "agree about that subset" — that sentence is for subset-vs-subset only.
      withSonnetRun({
        coverage: { mode: "first", datasetCaseCount: 500, selectedCaseCount: 20, sampleSeed: null },
      });
      mount();
      expect(screen.getByText(/exploratory/)).toBeTruthy();
      expect(screen.getByText(/Subset · 20 of 500 cases · first/)).toBeTruthy();
      expect(screen.queryByText(/only agree about that subset/)).toBeNull();
      expect(screen.queryByText(/API limit/)).toBeNull();
    });

    it("says two subsets only agree about that subset when every run is a subset", () => {
      const subset = {
        coverage: { mode: "first", datasetCaseCount: 500, selectedCaseCount: 20, sampleSeed: null },
      };
      hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
        ids.map((id) => {
          const base = RESP[id] as typeof OPUS;
          return {
            data: { ...base, run: { ...base.run, ...subset } },
            isLoading: false,
            isError: false,
          };
        }),
      );
      mount();
      expect(screen.getByText(/exploratory/)).toBeTruthy();
      expect(screen.getByText(/only agree about that subset/)).toBeTruthy();
    });

    it("leaves a run whose coverage was never reported unflagged, as every run today is", () => {
      withSonnetRun({
        coverage: {
          mode: "unknown",
          datasetCaseCount: null,
          selectedCaseCount: null,
          sampleSeed: null,
        },
      });
      mount();
      expect(screen.queryByText(/exploratory/)).toBeNull();
    });

    it("blames the API cap only when the API actually capped the response", () => {
      withSonnetRun({ resultsTruncated: true });
      mount();
      expect(screen.getByText(/API limit/)).toBeTruthy();
      // A full run that was merely capped is still a whole-dataset run, so it does not
      // also earn the exploratory banner.
      expect(screen.queryByText(/exploratory/)).toBeNull();
    });
  });

  it("guards against comparing runs on different datasets", () => {
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data:
          id === "sonnet"
            ? { ...SONNET, run: { ...SONNET.run, datasetName: "a-different-dataset" } }
            : RESP[id],
        isLoading: false,
        isError: false,
      })),
    );
    mount();
    expect(screen.getByText(/different datasets/)).toBeTruthy();
  });
});
