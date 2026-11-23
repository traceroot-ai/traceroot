// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { fixtureResult, fixtureScore, QUALITY } from "../__tests__/paired-fixture";
import { inferMetricFormat } from "../metric-format";
import type { ScorerColumn } from "../model";
import { ScoresTable } from "./scores-table";

afterEach(() => cleanup());

const column: ScorerColumn = {
  name: QUALITY,
  valueType: "numeric",
  direction: "higher_is_better",
  format: inferMetricFormat("numeric", [0.5]),
};

describe("ScoresTable", () => {
  it("reads the row the comparison reads when a scorer has two versions", () => {
    const superseded = {
      ...fixtureScore(QUALITY, 0.9),
      id: "v1",
      scorerVersion: "1",
      explanation: "Old judge.",
    };
    const current = {
      ...fixtureScore(QUALITY, 0.6),
      id: "v2",
      scorerVersion: "2",
      explanation: "Current judge.",
    };
    // The superseded row is listed last, so a plain find would take it.
    const result = fixtureResult("run-1", "case-1", "Ticket 1", [current, superseded]);
    render(
      <ScoresTable
        scorers={[column]}
        baseline={{ result, heading: "Baseline · #1", dot: "#000" }}
        candidate={{ result: undefined, heading: "Candidate · #2", dot: "#000" }}
        comparison={null}
      />,
    );
    const row = within(screen.getByRole("table")).getByText(QUALITY).closest("tr")!;
    expect(within(row).getByText("Current judge.")).toBeTruthy();
    expect(within(row).queryByText("Old judge.")).toBeNull();
    expect(within(row).getByText(/60\.0%/)).toBeTruthy();
    expect(within(row).getByText("No result")).toBeTruthy();
  });
});
