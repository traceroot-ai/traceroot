// @vitest-environment jsdom
/**
 * Adding runs to a comparison from the comparison page: a searchable list of the
 * project's other runs, led by the previous run on the same dataset, with runs on another
 * dataset marked as lined up by input.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, within, fireEvent, waitFor } from "@testing-library/react";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
  fixtureRun,
} from "./compare/__tests__/paired-fixture";
import type { ComponentProps } from "react";
import type { RunRow } from "./types";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({
  useEvaluationRunDetails: vi.fn(),
  useEvaluationRuns: vi.fn(),
}));
vi.mock("./hooks", () => hooks);

import { NO_ANALYSIS } from "./compare/filters";
import { openRuns } from "./compare/__tests__/runs-menu";
import { CompareRunsView } from "./views/compare-runs-view";

const OLDEST_RUN = fixtureRun("run-0", 0, "legacy-v0", "2026-10-31T10:00:00.000Z");
const NEWER_RUN = fixtureRun("run-4", 4, "extra-v4", "2026-11-04T10:00:00.000Z", {
  status: "completed_with_errors",
});
const OTHER_DATASET_RUN = fixtureRun("run-x", 1, "other-v1", "2026-11-02T12:00:00.000Z", {
  evaluationId: "ev2",
  evaluationName: "refund-routing",
  datasetId: "ds2",
  datasetName: "refunds",
});
const PROJECT_RUNS: RunRow[] = [
  OLDEST_RUN,
  BASELINE_RUN,
  CANDIDATE_RUN,
  OTHER_DATASET_RUN,
  FAST_RUN,
  NEWER_RUN,
];

/** The runs list route, newest first, for the filters the picker sends. */
function listRuns(
  _projectId: string,
  q: { dataset_id?: string; started_before?: string; search_query?: string; limit?: number },
) {
  const data = PROJECT_RUNS.filter(
    (r) =>
      (!q.dataset_id || r.datasetId === q.dataset_id) &&
      (!q.started_before || r.startedAt <= q.started_before) &&
      (!q.search_query ||
        `${r.candidateVersion} ${r.evaluationName}`.includes(q.search_query.toLowerCase())),
  )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, q.limit ?? 50);
  return { data: { data, meta: { page: 0, limit: q.limit ?? 50, total: data.length } } };
}

beforeEach(() => {
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: PAIRED_FIXTURE.find((b) => b.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
  hooks.useEvaluationRuns.mockImplementation(listRuns);
});
afterEach(() => cleanup());

const SELECTED = [CANDIDATE_RUN.id, FAST_RUN.id];

const view = (
  onChangeRuns: ComponentProps<typeof CompareRunsView>["onChangeRuns"],
  runIds = SELECTED,
) => (
  <CompareRunsView
    projectId="p1"
    runIds={runIds}
    baselineId={null}
    onChangeBaseline={vi.fn()}
    onChangeRuns={onChangeRuns}
    inspected={null}
    onInspect={vi.fn()}
  />
);
const mount = (onChangeRuns = vi.fn()) => {
  render(view(onChangeRuns));
  return onChangeRuns;
};

/** Add runs, from the Runs menu. */
const openPicker = async () => {
  fireEvent.click((await openRuns()).getByRole("button", { name: "Add runs" }));
  return within(await screen.findByRole("dialog", { name: "Add runs" }));
};
const options = (picker: ReturnType<typeof within>) =>
  picker.getAllByRole("button").map((b: HTMLElement) => b.textContent);

describe("CompareRunsView — add runs", () => {
  it("suggests the previous run on the same dataset first", async () => {
    mount();
    const picker = await openPicker();
    // #3 is the newest selected run; #2 is already selected, so #1 came before it.
    expect(picker.getByText("Suggested · previous run")).toBeTruthy();
    expect(options(picker)[0]).toBe("#1 baseline-v1support-routing");
  });

  it("lists the project's other runs, never one already selected", async () => {
    mount();
    const picker = await openPicker();
    expect(options(picker)).toEqual([
      "#1 baseline-v1support-routing",
      "#4 extra-v4Completed with errorssupport-routing",
      "#1 other-v1refund-routing· aligned by input",
      "#0 legacy-v0support-routing",
    ]);
  });

  it("adds the chosen run to the comparison, keeping the baseline", async () => {
    const onChangeRuns = mount();
    const picker = await openPicker();
    fireEvent.click(picker.getByRole("button", { name: /extra-v4/ }));
    // No baseline in the URL: #2 is the baseline as the oldest run, and stays it.
    expect(onChangeRuns).toHaveBeenCalledWith(
      [...SELECTED, NEWER_RUN.id],
      CANDIDATE_RUN.id,
      NO_ANALYSIS,
    );
  });

  it("keeps the baseline when the added run is older than it", async () => {
    const onChangeRuns = mount();
    const picker = await openPicker();
    fireEvent.click(picker.getByRole("button", { name: /legacy-v0/ }));
    expect(onChangeRuns).toHaveBeenCalledWith(
      [...SELECTED, OLDEST_RUN.id],
      CANDIDATE_RUN.id,
      NO_ANALYSIS,
    );
  });

  it("keeps a run's name whole, so its status and evaluation name shorten first", async () => {
    mount();
    const picker = await openPicker();
    const option = within(picker.getByRole("button", { name: /extra-v4/ }));
    const name = option.getByText("#4 extra-v4");
    expect(name.className).toContain("shrink-0");
    expect(name.className).not.toContain("min-w-0");
    for (const text of ["Completed with errors", "support-routing"]) {
      expect(option.getByText(text).className).toMatch(/min-w-0.*truncate|truncate.*min-w-0/);
    }
  });

  it("returns focus to the search box once a run is added", async () => {
    const onChangeRuns = vi.fn();
    const { rerender } = render(view(onChangeRuns));
    const picker = await openPicker();
    const added = picker.getByRole("button", { name: /extra-v4/ });
    added.focus();
    fireEvent.click(added);
    // The page adds the run to the URL, so it leaves the list; focus must not fall back
    // to the page.
    rerender(view(onChangeRuns, [...SELECTED, NEWER_RUN.id]));
    expect(picker.queryByRole("button", { name: /extra-v4/ })).toBeNull();
    expect(document.activeElement).toBe(picker.getByRole("textbox", { name: "Search runs" }));
  });

  it("lists nothing until the suggestion is known, so rows never shift", async () => {
    hooks.useEvaluationRuns.mockImplementation((p: string, q: Parameters<typeof listRuns>[1]) =>
      q.dataset_id ? { data: undefined, isLoading: true } : listRuns(p, q),
    );
    mount();
    const picker = await openPicker();
    expect(picker.getByText("Loading runs…")).toBeTruthy();
    expect(picker.queryAllByRole("button")).toHaveLength(0);
  });

  it("waits for the suggestion of the runs now selected, not the last selection's", async () => {
    hooks.useEvaluationRuns.mockImplementation((p: string, q: Parameters<typeof listRuns>[1]) =>
      q.dataset_id ? { ...listRuns(p, q), isPlaceholderData: true } : listRuns(p, q),
    );
    mount();
    const picker = await openPicker();
    expect(picker.getByText("Loading runs…")).toBeTruthy();
    expect(picker.queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps a run's alignment note whole and names what a shortened label says", async () => {
    mount();
    const picker = await openPicker();
    const other = within(picker.getByRole("button", { name: /other-v1/ }));
    expect(other.getByText("· aligned by input").className).toContain("shrink-0");
    expect(other.getByText("refund-routing").getAttribute("title")).toBe("refund-routing");
    const newer = within(picker.getByRole("button", { name: /extra-v4/ }));
    expect(newer.getByText("Completed with errors").getAttribute("title")).toBe(
      "Completed with errors",
    );
  });

  it("lists twenty runs not compared yet, even when compared runs are among the newest", async () => {
    // Twenty more runs on the dataset, older than all the others; #2 and #3 are among the
    // newest.
    const older = Array.from({ length: 20 }, (_, i) =>
      fixtureRun(`old-${i}`, 100 + i, `old-v${i}`, `2026-10-${String(i + 1).padStart(2, "0")}`),
    );
    hooks.useEvaluationRuns.mockImplementation((p: string, q: Parameters<typeof listRuns>[1]) => {
      const data = [...listRuns(p, { ...q, limit: undefined }).data.data, ...older].slice(
        0,
        q.limit,
      );
      return { data: { data, meta: { page: 0, limit: q.limit, total: data.length } } };
    });
    mount();
    const picker = await openPicker();
    // The suggestion, then nineteen more.
    expect(options(picker)).toHaveLength(20);
    expect(options(picker)[0]).toBe("#1 baseline-v1support-routing");
  });

  it("finds runs by version or evaluation name", async () => {
    mount();
    const picker = await openPicker();
    fireEvent.change(picker.getByPlaceholderText("Search runs..."), {
      target: { value: "refund" },
    });
    await waitFor(() =>
      expect(options(picker)).toEqual(["#1 other-v1refund-routing· aligned by input"]),
    );
    expect(picker.queryByText("Suggested · previous run")).toBeNull();
  });
});
