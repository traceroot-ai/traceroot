// @vitest-environment jsdom
/**
 * Reading the comparison table at N runs, on three runs of one 12-case dataset (see
 * `compare/__tests__/paired-fixture.ts`). While the table scrolls, its label row stays on
 * top and the Input and Run columns stay on the left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
} from "./compare/__tests__/paired-fixture";
import { linesOf, summaryGroup } from "./compare/__tests__/table-grid";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({
  useEvaluationRunDetails: vi.fn(),
  useEvaluationRuns: vi.fn(),
}));
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
  hooks.useEvaluationRuns.mockReturnValue({
    data: { data: [], meta: { page: 0, limit: 20, total: 0 } },
    isLoading: false,
  });
});
afterEach(() => cleanup());

const view = () => (
  <CompareRunsView
    projectId="p1"
    runIds={RUN_IDS}
    baselineId={null}
    onChangeBaseline={vi.fn()}
    onChangeRuns={vi.fn()}
    inspected={null}
    onInspect={vi.fn()}
  />
);

/** Each case's first line, which holds its Input. */
const bodyRows = () => Array.from(document.querySelectorAll<HTMLElement>("tbody tr[data-row]"));
const headRows = () => Array.from(document.querySelectorAll<HTMLElement>("thead tr"));

describe("CompareRunsView — pinned input, run and headers", () => {
  const pinned = (cell: Element | null | undefined) =>
    !!cell && cell.classList.contains("col-sticky-start");

  it("keeps the column labels on top while the table scrolls, and the summary scrolls away", () => {
    render(view());
    const head = document.querySelector("thead") as HTMLElement;
    // The head is the label row alone; the summary is the body's first group, so it
    // scrolls with the cases and leaves them the room.
    expect(head.className).not.toMatch(/\bsticky\b/);
    expect(headRows()).toHaveLength(1);
    expect(headRows()[0].className).toContain("row-sticky-top");
    expect(summaryGroup().closest("thead")).toBeNull();
    expect(summaryGroup().querySelector(".row-sticky-top")).toBeNull();
  });

  it("pins the Input column, in the header, the summary and every case, and the Run column", () => {
    render(view());
    const rows = [...headRows(), linesOf(summaryGroup())[0], ...bodyRows()];
    expect(rows).toHaveLength(14);
    expect(rows.every((tr) => pinned(tr.querySelector("th, td")))).toBe(true);
    expect(document.querySelectorAll(".col-sticky-start")).toHaveLength(14);
    // Run is pinned at Input's width, in the header and on every line.
    expect(document.querySelectorAll(".left-\\[240px\\]")).toHaveLength(1 + 3 + 36);
  });
});
