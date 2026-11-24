// @vitest-environment jsdom
/**
 * The paired summary lines, rendered straight from model data: the pair with nothing to
 * average, the cases a scorer count leaves out, and a categorical scorer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, within, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MeanSummary, ScorerSummary } from "./pair-summary";
import {
  buildCompareModel,
  comparePairs,
  countCellsByScorer,
  pairExclusions,
  type RunBundle,
} from "./model";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  PAIRED_FIXTURE,
  QUALITY,
  ROUTE,
  fixtureResult,
  fixtureRun,
  fixtureScore,
  scorerManifest,
} from "./__tests__/paired-fixture";

afterEach(() => cleanup());

const tagOf = (runId: string) => `#${runId}`;

/** Renders one scorer's summary line for the pair whose candidate is `candidateId`. */
function renderScorer(bundles: RunBundle[], baselineId: string, candidateId: string, name: string) {
  const model = buildCompareModel(bundles, baselineId);
  const pair = comparePairs(model).get(candidateId)!;
  return render(
    <TooltipProvider>
      <ScorerSummary
        pair={pair}
        exclusions={pairExclusions(model, pair)}
        counts={countCellsByScorer(pair)}
        column={model.scorers.find((s) => s.name === name)!}
        tagOf={tagOf}
      />
    </TooltipProvider>,
  );
}

const two = (aResults: RunBundle["results"], bResults: RunBundle["results"]): RunBundle[] => [
  { run: fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z"), results: aResults },
  { run: fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z"), results: bResults },
];

describe("ScorerSummary", () => {
  it("shows a dash and n=0, never 0, when no case was scored in both runs", async () => {
    const { container } = renderScorer(
      two(
        [fixtureResult("a", "tc-1", "one", [fixtureScore(QUALITY, 0.5)])],
        [fixtureResult("b", "tc-1", "one", [], { status: "not_scored" })],
      ),
      "a",
      "b",
      QUALITY,
    );
    expect(container.textContent).toContain("—");
    const n = screen.getByText("n=0");
    expect(container.textContent).toMatch(/^—n=0/);
    fireEvent.focus(n);
    const tooltip = within(await screen.findByRole("tooltip"));
    expect(tooltip.getByText("No case was scored in both runs.")).toBeTruthy();
  });

  it("lists a scorer version and a value type difference under Not included", async () => {
    renderScorer(
      two(
        [
          fixtureResult("a", "tc-1", "one", [fixtureScore(QUALITY, 0.5)]),
          fixtureResult("a", "tc-2", "two", [fixtureScore(QUALITY, 0.5)]),
          fixtureResult("a", "tc-3", "three", [fixtureScore(QUALITY, 0.5)]),
        ],
        [
          fixtureResult("b", "tc-1", "one", [
            { ...fixtureScore(QUALITY, 0.7), scorerVersion: "2" },
          ]),
          fixtureResult("b", "tc-2", "two", [fixtureScore(QUALITY, "high")]),
          fixtureResult("b", "tc-3", "three", [fixtureScore(QUALITY, 0.7)]),
        ],
      ),
      "a",
      "b",
      QUALITY,
    );
    fireEvent.focus(screen.getByText("n=1"));
    const tooltip = within(await screen.findByRole("tooltip"));
    expect(tooltip.getByText("Changes across the 1 case both runs scored.")).toBeTruthy();
    expect(tooltip.getByText("Not included:")).toBeTruthy();
    expect(tooltip.getByText("1 case scored by different scorer versions")).toBeTruthy();
    expect(tooltip.getByText("1 case scored as different value types")).toBeTruthy();
  });

  it("colours a pair's numeric change when another run records text for the scorer", () => {
    // Bare `{ name, version }` scorers, so each value type comes from what was recorded.
    const run = (id: string, day: number, value: number | string): RunBundle => ({
      run: fixtureRun(id, day, id, `2026-11-0${day}T00:00:00Z`, {
        scorers: scorerManifest([{ name: QUALITY, version: "1" }]),
      }),
      results: [fixtureResult(id, "tc-1", "one", [fixtureScore(QUALITY, value)])],
    });
    const { container } = renderScorer(
      [run("a", 1, 0.4), run("b", 2, 0.8), run("c", 3, "high")],
      "a",
      "b",
      QUALITY,
    );
    // The column reads as labels, since one run recorded text; the pair still has means.
    expect(container.textContent).toContain("0.4 → 0.8");
    expect(screen.getByText("+0.4").className).toContain("text-emerald-600");
  });

  it("reads a categorical scorer as how many cases changed", async () => {
    const { container } = renderScorer(PAIRED_FIXTURE, BASELINE_RUN.id, CANDIDATE_RUN.id, ROUTE);
    expect(container.textContent).toContain("changed 1 of 8");
    fireEvent.focus(screen.getByText("n=8"));
    const tooltip = within(await screen.findByRole("tooltip"));
    expect(tooltip.getByText("Changes across the 8 cases both runs scored.")).toBeTruthy();
  });
});

describe("MeanSummary", () => {
  it("shows a dash and n=0 when no case reported the measure in both runs", async () => {
    const { container } = render(
      <TooltipProvider>
        <MeanSummary
          mean={{ baselineMean: null, candidateMean: null, delta: null, pairedCount: 0 }}
          measure="latency"
          fmt={String}
          fmtDelta={String}
        />
      </TooltipProvider>,
    );
    expect(container.textContent).toContain("—");
    fireEvent.focus(screen.getByText("n=0"));
    const tooltip = within(await screen.findByRole("tooltip"));
    expect(tooltip.getByText("No case has a latency in both runs.")).toBeTruthy();
  });
});
