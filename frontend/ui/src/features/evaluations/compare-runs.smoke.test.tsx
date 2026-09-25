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

const runDetail = (id: string, runNumber: number, ver: string) => ({
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
