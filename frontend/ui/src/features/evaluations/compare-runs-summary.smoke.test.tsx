// @vitest-environment jsdom
/**
 * The run comparison page's numbers, on three runs of one 12-case dataset whose scored
 * rows differ (see `compare/__tests__/paired-fixture.ts`): every metric column keeps one
 * format for all its values, so a count never reads as a percentage, and the summary row
 * compares each candidate with the baseline on only the cases both of them scored.
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

/** The `<td>` under the column headed `header` in `row`. */
function cellIn(row: HTMLElement, header: string): HTMLElement {
  const index = screen
    .getAllByRole("columnheader")
    .findIndex((h) => h.textContent?.startsWith(header));
  if (index === -1) throw new Error(`No column header starts with "${header}"`);
  return row.querySelectorAll("td")[index] as HTMLElement;
}
const caseRow = (input: string) => screen.getByText(input).closest("tr") as HTMLElement;
/** The summary row: the header's second row, under the column labels. */
const summaryRow = () => document.querySelectorAll("thead tr")[1] as HTMLElement;

describe("CompareRunsView — metric formats", () => {
  it("leaves a change uncoloured on a scorer declared to have no direction", () => {
    const scorers = scorerManifest([{ name: "similarity", version: "1", direction: "none" }]);
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z", { scorers });
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z", { scorers });
    const runs = [
      {
        run: a,
        results: [fixtureResult("a", "tc-1", "Ticket 1", [fixtureScore("similarity", 0.2)])],
      },
      {
        run: b,
        results: [fixtureResult("b", "tc-1", "Ticket 1", [fixtureScore("similarity", 0.5)])],
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
    const change = within(cellIn(caseRow("Ticket 1"), "similarity")).getByText("+30.0 pp");
    expect(change.className).toContain("text-muted-foreground");
    expect(change.className).not.toMatch(/text-(emerald|red)-/);
  });

  it("shows no change for a latency or cost difference that reads as nothing", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z");
    // A third of a millisecond, and float noise in a sum, are no change at the shown precision.
    const runs = [
      {
        run: a,
        results: [fixtureResult("a", "tc-1", "Ticket 1", [], { durationMs: 1000, cost: 0.3 })],
      },
      {
        run: b,
        results: [
          fixtureResult("b", "tc-1", "Ticket 1", [], { durationMs: 1000.3, cost: 0.1 + 0.2 }),
        ],
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
    const row = caseRow("Ticket 1");
    for (const [header, text] of [
      ["Latency", "0ms"],
      ["Cost", "$0"],
    ]) {
      expect(within(cellIn(row, header)).queryByText(text)).toBeNull();
    }
  });

  it("shows a count scorer's values and changes as counts", () => {
    mount();
    const policy = cellIn(caseRow("Ticket 2"), POLICY);
    // #1 and #3 recorded 0 violations, #2 recorded 2 (+2, never "+200.0%").
    expect(within(policy).getAllByText("0")).toHaveLength(2);
    expect(within(policy).getByText("2")).toBeTruthy();
    expect(within(policy).getByText("+2")).toBeTruthy();
    expect(policy.textContent).not.toContain("%");
    // Nowhere does a count's mean turn into a percentage.
    expect(screen.queryByText("25.0%")).toBeNull();
  });

  it("shows a [0,1] scorer's values as percentages and its changes in points", () => {
    mount();
    const quality = cellIn(caseRow("Ticket 2"), QUALITY);
    expect(within(quality).getByText("85.0%")).toBeTruthy();
    expect(within(quality).getByText("30.0%")).toBeTruthy();
    expect(within(quality).getByText("−55.0 pp")).toBeTruthy();
  });
});

describe("CompareRunsView — run identity", () => {
  it("names the run behind each stacked value, not only by colour", () => {
    mount();
    const quality = cellIn(caseRow("Ticket 2"), QUALITY);
    const labels = [...quality.querySelectorAll("[title]")].map((e) => e.getAttribute("title"));
    expect(labels).toHaveLength(3);
    for (const l of labels) expect(l).toMatch(/^#\d+ \S/);
    expect(quality.querySelectorAll(".sr-only")).toHaveLength(3);
    expect(quality.querySelector(".sr-only")!.textContent).toMatch(/^#\d+ .+: $/);
    expect(quality.querySelector(".sr-only")!.className).toContain("select-none");
  });

  it("leaves a value that has its own tooltip without a native title", () => {
    mount();
    const output = cellIn(caseRow("Ticket 2"), "Output");
    expect(output.querySelectorAll(".sr-only").length).toBeGreaterThan(0);
    expect(output.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("names the run behind each summary entry", () => {
    mount();
    const quality = cellIn(summaryRow(), QUALITY);
    expect(quality.querySelectorAll("[title]")).toHaveLength(0);
    expect(quality.querySelectorAll(".sr-only")).toHaveLength(3);
  });
});

describe("CompareRunsView — summary row", () => {
  it("compares each candidate with the baseline on the cases both of them scored", () => {
    mount();
    const quality = cellIn(summaryRow(), QUALITY);
    expect(within(quality).getByText("Baseline")).toBeTruthy();
    // #1 averages 10 scored rows (80.5%) and #2 only 7; paired on those 7 it is 78.6%.
    expect(within(quality).getByText("78.6% → 82.1%")).toBeTruthy();
    expect(within(quality).getByText("+3.6 pp")).toBeTruthy();
    expect(within(quality).getByText("n=7")).toBeTruthy();
    expect(screen.queryByText(/80\.5%/)).toBeNull();
  });

  it("pairs each candidate on the cases it shares with the baseline, whatever the others hold", () => {
    mount();
    // #3 has every case, so it shares 11 with #1, although #2 has no case 9.
    const quality = cellIn(summaryRow(), QUALITY);
    expect(within(quality).getByText("80.9% → 80.0%")).toBeTruthy();
    expect(within(quality).getByText("−0.9 pp")).toBeTruthy();
    expect(within(quality).getByText("n=11")).toBeTruthy();
  });

  it("names the cases left out of a pair's count, by reason", async () => {
    mount();
    fireEvent.focus(within(cellIn(summaryRow(), QUALITY)).getByText("n=7"));
    const tooltip = within(await screen.findByRole("tooltip"));
    expect(tooltip.getByText("Mean of the 7 cases both runs scored.")).toBeTruthy();
    for (const line of [
      "1 case with no result in #1",
      "1 case with no result in #2",
      "1 case with a task error in #2",
      "1 case with a scorer error in #2",
      "1 case not scored in #2",
    ]) {
      expect(tooltip.getByText(line)).toBeTruthy();
    }
  });

  it("keeps a count scorer's summary in counts, coloured by its direction", () => {
    mount();
    const policy = cellIn(summaryRow(), POLICY);
    expect(within(policy).getByText("0 → 0.25")).toBeTruthy();
    // Lower is better: more violations is a regression.
    expect(within(policy).getByText("+0.25").className).toContain("text-red-600");
    expect(within(policy).getByText("n=8")).toBeTruthy();
  });

  it("counts a categorical scorer's changes without a numeric delta", () => {
    mount();
    const route = cellIn(summaryRow(), ROUTE);
    expect(within(route).getByText("changed 1 of 8")).toBeTruthy();
    expect(route.textContent).not.toMatch(/→|pp|[+−]\d/);
  });
});

describe("CompareRunsView — latency and cost", () => {
  it("shows each pair's mean case latency and cost instead of summed totals", () => {
    mount();
    expect(screen.getByRole("columnheader", { name: "Latency (mean)" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Cost (mean)" })).toBeTruthy();
    // #1 and #2 both timed the 10 cases they share: 1000ms vs 1200ms on each.
    const latency = cellIn(summaryRow(), "Latency");
    expect(within(latency).getByText("1.0s → 1.2s")).toBeTruthy();
    expect(within(latency).getByText("+200ms").className).toContain("text-red-600");
    expect(within(latency).getAllByText("n=10").length).toBeGreaterThan(0);
    const cost = cellIn(summaryRow(), "Cost");
    expect(within(cost).getByText("$0.0100 → $0.0200")).toBeTruthy();
    expect(within(cost).getByText("+$0.0100")).toBeTruthy();
    // Never the sums (12.0s / $0.2000 for #2's 10 shared cases).
    expect(screen.queryByText(/12\.0s/)).toBeNull();
    expect(screen.queryByText(/\$0\.2000/)).toBeNull();
  });
});

describe("CompareRunsView — improved and regressed counts", () => {
  it("counts each candidate's improved and regressed cases under a scorer", () => {
    mount();
    const quality = cellIn(summaryRow(), QUALITY);
    const counts = within(quality).getByLabelText("6 improved, 1 regressed vs baseline");
    expect(counts.textContent).toBe("↗ 6↘ 1");
    // Lower is better: #2's extra violations on case 2 is its one regression.
    expect(
      within(cellIn(summaryRow(), POLICY)).getByLabelText("0 improved, 1 regressed vs baseline"),
    ).toBeTruthy();
  });

  it("has no improved or regressed counts for a categorical scorer", () => {
    mount();
    expect(within(cellIn(summaryRow(), ROUTE)).queryByLabelText(/improved/)).toBeNull();
  });
});

describe("CompareRunsView — score rows", () => {
  it("shows the value the comparison used when a scorer recorded twice", () => {
    // The candidate's newer scorer version re-scored the case. The comparison reads that
    // row, so the case's cell and the summary read it too, not the first row listed.
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z");
    const runs = [
      {
        run: a,
        results: [
          fixtureResult("a", "tc-1", "Ticket 1", [
            { ...fixtureScore(QUALITY, 0.5), scorerVersion: "2" },
          ]),
        ],
      },
      {
        run: b,
        results: [
          fixtureResult("b", "tc-1", "Ticket 1", [
            { ...fixtureScore(QUALITY, 0.9), scorerVersion: "1" },
            { ...fixtureScore(QUALITY, 0.6), scorerVersion: "2" },
          ]),
        ],
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
    const cell = cellIn(caseRow("Ticket 1"), QUALITY);
    expect(within(cell).getByText("60.0%")).toBeTruthy();
    expect(within(cell).getByText("+10.0 pp")).toBeTruthy();
    expect(within(cellIn(summaryRow(), QUALITY)).getByText("50.0% → 60.0%")).toBeTruthy();
    expect(screen.queryByText("90.0%")).toBeNull();
  });
});
