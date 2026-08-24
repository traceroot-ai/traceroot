// @vitest-environment jsdom
/**
 * The N-run "Run Comparison" page: 2+ runs lined up case-by-case, anchored on the
 * baseline. Runs on the baseline's dataset (compared by the stable `datasetId`) align
 * by dataset-row id; runs on a different dataset align by shared (canonical) input — so
 * a mixed selection compares fine and a same-dataset pair keeps exact row identity even
 * alongside cross-dataset runs. One colour-keyed value per run stacks in each metric
 * cell. Asserts the scorer columns, the per-run stacked values, the baseline legend,
 * that Input collapses when the runs agree, cross-dataset (and 3-run mixed) alignment,
 * and that the removed chrome (swap / main score / status / filter tabs / verdict / row
 * drill-in) is gone.
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

  it("compares runs across datasets by shared input (no refusal)", () => {
    // The other run is on a DIFFERENT dataset, so its cases carry different
    // (dataset-scoped) testCaseIds — but the same inputs. Old behaviour refused; the
    // new behaviour aligns on the shared inputs.
    const OTHER = {
      run: { ...SONNET.run, datasetId: "ds2", datasetName: "tickets-v2", datasetVersionId: "dv2" },
      results: [
        // Same inputs as OPUS, but different testCaseIds (a different dataset).
        result("tc_other_01", "Ticket 1: my invoice looks wrong", "billing", {
          routing_accuracy: 1,
          is_known_category: 1,
        }),
        result(
          "tc_other_05",
          "Ticket 5: my card was double-charged and I want a refund",
          "account_management",
          { routing_accuracy: 0, is_known_category: 1 },
        ),
      ],
    };
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: id === "sonnet" ? OTHER : RESP[id],
        isLoading: false,
        isError: false,
      })),
    );
    mount();
    // Not blocked: no "needs the same dataset" refusal.
    expect(screen.queryByText(/needs the same dataset/)).toBeNull();
    // An informational banner explains the cross-dataset alignment.
    expect(screen.getByText(/aligned by shared input/)).toBeTruthy();
    // Both shared inputs align into rows despite disjoint testCaseIds.
    expect(screen.getByText(/my invoice looks wrong/)).toBeTruthy();
    const row = screen
      .getByText(/double-charged and I want a refund/)
      .closest("tr") as HTMLTableRowElement;
    // Aligned pair still produces the regression delta against the baseline.
    expect(within(row).getByText("−100.0%")).toBeTruthy();
  });

  it("shows the shared-input empty state when cross-dataset runs share no inputs", () => {
    const OTHER = {
      run: { ...SONNET.run, datasetId: "ds2", datasetName: "tickets-v2", datasetVersionId: "dv2" },
      results: [
        result("tc_other_99", "A wholly unrelated question about API keys", "billing", {
          routing_accuracy: 1,
          is_known_category: 1,
        }),
      ],
    };
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: id === "sonnet" ? OTHER : RESP[id],
        isLoading: false,
        isError: false,
      })),
    );
    mount();
    expect(screen.getByText(/share no inputs in common/)).toBeTruthy();
  });

  it("still aligns same-dataset runs by testCaseId, not input", () => {
    // Same dataset, IDENTICAL testCaseIds, but the inputs were edited to differ. The
    // rows must still line up (by id) — proving the common path did not switch to
    // input-keying.
    const EDITED = {
      run: SONNET.run,
      results: [
        result("ticket-01", "EDITED input text one", "billing", {
          routing_accuracy: 1,
          is_known_category: 1,
        }),
        result("ticket-05", "EDITED input text five", "account_management", {
          routing_accuracy: 0,
          is_known_category: 1,
        }),
      ],
    };
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: id === "sonnet" ? EDITED : RESP[id],
        isLoading: false,
        isError: false,
      })),
    );
    mount();
    // No cross-dataset banner (same dataset name).
    expect(screen.queryByText(/aligned by shared input/)).toBeNull();
    // Both ids intersect → ticket-05 aligns and its regression delta is computed,
    // even though the two runs now carry different input text for that id.
    expect(screen.getByText("−100.0%")).toBeTruthy();
    // Both runs' (now-differing) inputs are shown for the edited case.
    expect(screen.getByText("EDITED input text five")).toBeTruthy();
  });

  it("aligns 3 runs on one dataset by testCaseId even when the dataset was renamed", () => {
    // Three runs on the SAME dataset (datasetId ds1), but the dataset was renamed between
    // runs, so they carry different datasetNames. Detection keys off the stable datasetId,
    // NOT the mutable name — so this stays a same-dataset comparison (testCaseId alignment):
    // a 3rd run never flips the set to fuzzy input matching, and edited inputs still line up.
    const B = {
      run: { ...runDetail("sonnet", 42, "sonnet"), datasetName: "ticket-routing-v2" },
      results: [
        result("ticket-01", "Ticket 1: my invoice looks wrong", "billing", {
          routing_accuracy: 1,
          is_known_category: 1,
        }),
        result("ticket-05", "EDITED five (sonnet)", "account_management", {
          routing_accuracy: 0,
          is_known_category: 1,
        }),
      ],
    };
    const C = {
      run: { ...runDetail("haiku", 43, "haiku"), datasetName: "ticket-routing-v3" },
      results: [
        result("ticket-01", "Ticket 1: my invoice looks wrong", "billing", {
          routing_accuracy: 1,
          is_known_category: 1,
        }),
        result("ticket-05", "EDITED five (haiku)", "account_management", {
          routing_accuracy: 0,
          is_known_category: 1,
        }),
      ],
    };
    const R: Record<string, unknown> = { opus: OPUS, sonnet: B, haiku: C };
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({ data: R[id], isLoading: false, isError: false })),
    );
    render(
      <CompareRunsView
        projectId="p1"
        runIds={["opus", "sonnet", "haiku"]}
        baselineId="opus"
        onChangeBaseline={vi.fn()}
      />,
    );
    // Same datasetId across all three → NOT cross-dataset, despite the differing names.
    expect(screen.queryByText(/aligned by shared input/)).toBeNull();
    // ticket-05 aligns by row id across all three (its inputs were edited apart) → the
    // regression delta is computed and BOTH candidates' edited inputs are shown.
    const row = screen.getByText("EDITED five (sonnet)").closest("tr") as HTMLTableRowElement;
    expect(within(row).getByText("EDITED five (haiku)")).toBeTruthy();
    expect(within(row).getAllByText("−100.0%").length).toBeGreaterThan(0);
  });

  it("keeps a same-dataset pair on testCaseId when a cross-dataset run joins the selection", () => {
    // A and B are on ds1 (B's ticket-05 input was EDITED, same testCaseId); C is on a
    // DIFFERENT dataset ds2 with matching inputs. The A/B pair must still align by row id
    // — so B's edited-input case is NOT dropped by the global switch to input matching —
    // while C aligns by shared input. (Regression guard for the single-global-flag bug.)
    const B = {
      run: SONNET.run, // ds1
      results: [
        result("ticket-01", "Ticket 1: my invoice looks wrong", "billing", {
          routing_accuracy: 1,
          is_known_category: 1,
        }),
        result("ticket-05", "EDITED-B double-charged", "account_management", {
          routing_accuracy: 0,
          is_known_category: 1,
        }),
      ],
    };
    const C = {
      run: {
        ...runDetail("haiku", 43, "haiku"),
        datasetId: "ds2",
        datasetName: "tickets-v2",
        datasetVersionId: "dv2",
      },
      results: [
        result("tc_other_01", "Ticket 1: my invoice looks wrong", "billing", {
          routing_accuracy: 1,
          is_known_category: 1,
        }),
        result(
          "tc_other_05",
          "Ticket 5: my card was double-charged and I want a refund",
          "account_management",
          { routing_accuracy: 0, is_known_category: 1 },
        ),
      ],
    };
    const R: Record<string, unknown> = { opus: OPUS, sonnet: B, haiku: C };
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({ data: R[id], isLoading: false, isError: false })),
    );
    render(
      <CompareRunsView
        projectId="p1"
        runIds={["opus", "sonnet", "haiku"]}
        baselineId="opus"
        onChangeBaseline={vi.fn()}
      />,
    );
    // C spans datasets → the cross-dataset banner shows.
    expect(screen.getByText(/aligned by shared input/)).toBeTruthy();
    // The edited-input case survived: B's edited text is shown (aligned to A by row id,
    // not dropped for differing from A's input), and its regression delta is present.
    const row = screen.getByText("EDITED-B double-charged").closest("tr") as HTMLTableRowElement;
    expect(within(row).getAllByText("−100.0%").length).toBeGreaterThan(0);
  });

  it("dedupes a baseline's repeated input in cross-dataset mode (renders once, counts once)", () => {
    // The BASELINE run has TWO dataset rows carrying the SAME input (distinct testCaseIds,
    // differing scores). A cross-dataset run shares that input. Cross-dataset alignment keys
    // on canonical input, so the shared input must collapse to a SINGLE row and be counted
    // ONCE in the aggregates — not once per baseline row (which would double-count).
    const DUP = "Ticket 9: refund status for order 7788";
    const BASE = {
      run: runDetail("opus", 41, "opus"), // ds1
      results: [
        result("dup-a", DUP, "billing", { routing_accuracy: 1, is_known_category: 1 }),
        result("dup-b", DUP, "billing", { routing_accuracy: 0, is_known_category: 1 }),
      ],
    };
    const CROSS = {
      run: { ...runDetail("sonnet", 42, "sonnet"), datasetId: "ds2", datasetName: "tickets-v2" },
      results: [result("x1", DUP, "billing", { routing_accuracy: 1, is_known_category: 1 })],
    };
    const R: Record<string, unknown> = { opus: BASE, sonnet: CROSS };
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({ data: R[id], isLoading: false, isError: false })),
    );
    mount();
    // Cross-dataset banner confirms input-keyed alignment is in effect.
    expect(screen.getByText(/aligned by shared input/)).toBeTruthy();
    // The shared input renders exactly ONE row (deduped by canonical input), not two.
    expect(screen.getAllByText(DUP)).toHaveLength(1);
    // Counted once in the totals: baseline Duration total is 2.1s (one row @2100ms), not
    // 4.2s (two rows). The double-counted mean would also surface as a 50.0% aggregate.
    expect(screen.queryByText("4.2s")).toBeNull();
    expect(screen.queryByText("50.0%")).toBeNull();
    expect(screen.getAllByText("2.1s").length).toBeGreaterThan(0);
    // Keep-FIRST, not last-write-wins: the kept baseline row is the EARLIEST duplicate
    // (dup-a, routing_accuracy 100%), so its aggregate reads 100% and dup-b's 0% never
    // surfaces. A last-write-wins map would keep dup-b and render 0.0% here — this
    // assertion is what fails if the dedup policy silently flips.
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.getAllByText("100.0%").length).toBeGreaterThan(0);
  });
});
