// @vitest-environment jsdom
/**
 * Taking a comparison off the page, on three runs of one 12-case dataset (see
 * `compare/__tests__/paired-fixture.ts`). The toolbar's Export menu downloads exactly the
 * cases the table shows, in its order, as CSV (a plain table) or JSON (the same rows with
 * the runs, search, filters, sort and paired numbers they cover). With nothing to export
 * it is off and says why.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
} from "./compare/__tests__/paired-fixture";
import type { ComparisonExport } from "./compare/export";
import { NO_ANALYSIS, type CaseAnalysis } from "./compare/filters";
import { runLabeler, runTagger } from "./compare/run-tags";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({
  useEvaluationRunDetails: vi.fn(),
  useEvaluationRuns: vi.fn(),
}));
vi.mock("./hooks", () => hooks);

import { CompareRunsView } from "./views/compare-runs-view";

const RUN_IDS = [BASELINE_RUN.id, CANDIDATE_RUN.id, FAST_RUN.id];
const STAMP = "20261111-1405";
// The file names each run as the page does.
const BASELINE_LABEL = runLabeler(PAIRED_FIXTURE, runTagger(PAIRED_FIXTURE))(BASELINE_RUN.id);

const loaded = (ids: string[]) =>
  ids.map((id) => ({
    data: PAIRED_FIXTURE.find((b) => b.run.id === id),
    isLoading: false,
    isError: false,
  }));

const { createObjectURL, revokeObjectURL } = URL;
let blobs: Blob[];
let clicks: { href: string | null; download: string; attached: boolean }[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 11, 14, 5));
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) => loaded(ids));
  hooks.useEvaluationRuns.mockReturnValue({
    data: { data: [], meta: { page: 0, limit: 20, total: 0 } },
    isLoading: false,
  });
  blobs = [];
  clicks = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:export-${blobs.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  // jsdom can't follow a download link; record what would have been saved instead.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({
      href: this.getAttribute("href"),
      download: this.download,
      attached: document.body.contains(this),
    });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

const view = (analysis: CaseAnalysis = NO_ANALYSIS) => (
  <CompareRunsView
    projectId="p1"
    runIds={RUN_IDS}
    baselineId={null}
    onChangeBaseline={vi.fn()}
    onChangeRuns={vi.fn()}
    inspected={null}
    onInspect={vi.fn()}
    analysis={analysis}
  />
);

const casesRow = () => document.querySelector('[data-toolbar="cases"]') as HTMLElement;
const exportButton = () => within(casesRow()).getByRole("button", { name: "Export" });
/** Why Export is off, as its tooltip says when its wrapper takes focus. */
const offReason = async () => {
  fireEvent.focus(exportButton().parentElement as HTMLElement);
  return (await screen.findByRole("tooltip")).textContent;
};

/** Choose a format from the Export menu; resolves with the file it saved. */
async function exportAs(format: "CSV" | "JSON") {
  fireEvent.pointerDown(exportButton(), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(`^${format}`) }));
  await waitFor(() => expect(clicks).toHaveLength(1));
  const [blob] = blobs;
  // `text()` reads it as UTF-8, which drops a byte order mark; the bytes keep it.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { blob, bytes, text: await blob.text(), ...clicks[0] };
}

/** The case column of a CSV export, row by row. */
const csvCases = (text: string) =>
  text
    .split("\r\n")
    .slice(1, -1)
    .map((line) => line.split(",")[0]);

/** The table's inputs, top to bottom. */
const tableInputs = () =>
  Array.from(document.querySelectorAll("tbody tr[data-row]")).map(
    (tr) => tr.querySelector("td")?.textContent,
  );

describe("CompareRunsView — export", () => {
  it("puts Export at the end of the search, filters, sort and runs row", () => {
    render(view());
    const buttons = within(casesRow()).getAllByRole("button");
    expect(buttons[buttons.length - 1]).toBe(exportButton());
    expect(exportButton().hasAttribute("disabled")).toBe(false);
  });

  it("names each format with what it holds, title over hint", async () => {
    render(view());
    fireEvent.pointerDown(exportButton(), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("12 cases, in table order")).toBeTruthy();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => [...i.children].map((c) => c.textContent)),
    ).toEqual([
      ["CSV", "For spreadsheets"],
      ["JSON", "With the runs, filters and paired numbers"],
    ]);
  });

  it("downloads every case as CSV, named for the baseline, the cases and the time", async () => {
    // The file's address is let go a minute later: some browsers cancel a download whose
    // address goes away sooner.
    const realSetTimeout = globalThis.setTimeout;
    const later: (() => void)[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      run: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms !== 60_000) return realSetTimeout(run, ms, ...args);
      later.push(run);
      return 0;
    }) as unknown as typeof setTimeout);
    render(view());
    const file = await exportAs("CSV");
    expect(file.download).toBe(`comparison-1-baseline-v1-12-cases-${STAMP}.csv`);
    expect(file.href).toBe("blob:export-1");
    expect(file.attached).toBe(true);
    expect(file.blob.type).toBe("text/csv;charset=utf-8");
    expect([...file.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(
      file.text.startsWith(
        `case,input,expected,${BASELINE_LABEL} · output,${BASELINE_LABEL} · expected,`,
      ),
    ).toBe(true);
    // The table's order: the baseline's cases, then case 10, which it doesn't have.
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 10].map((n) => `id:case-${n}`);
    expect(csvCases(file.text)).toEqual(keys);
    expect(tableInputs()).toEqual(keys.map((key) => key.replace("id:case-", "Ticket ")));
    // The link is gone; the file's address stays until the minute is up.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(later).toHaveLength(1);
    later[0]();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export-1");
  });

  it("exports exactly the filtered cases, in the table's order", async () => {
    // Cases #2 improved on quality, biggest regression first: the five +0.05 cases, then
    // case 1 (+0.55).
    render(
      view({
        q: "",
        filters: [{ kind: "improved", scorer: "quality", runId: CANDIDATE_RUN.id }],
        sort: { kind: "regression", scorer: "quality", runId: CANDIDATE_RUN.id },
      }),
    );
    expect(tableInputs()).toEqual([
      "Ticket 3",
      "Ticket 4",
      "Ticket 5",
      "Ticket 11",
      "Ticket 12",
      "Ticket 1",
    ]);
    const file = await exportAs("CSV");
    expect(file.download).toBe(`comparison-1-baseline-v1-6-cases-${STAMP}.csv`);
    expect(csvCases(file.text)).toEqual([
      "id:case-3",
      "id:case-4",
      "id:case-5",
      "id:case-11",
      "id:case-12",
      "id:case-1",
    ]);
  });

  it("downloads JSON with the rows and the scope they cover", async () => {
    render(
      view({
        q: "ticket 1",
        filters: [{ kind: "improved", scorer: "quality", runId: CANDIDATE_RUN.id }],
        sort: { kind: "dataset" },
      }),
    );
    const file = await exportAs("JSON");
    expect(file.download).toBe(`comparison-1-baseline-v1-3-cases-${STAMP}.json`);
    expect(file.blob.type).toBe("application/json");
    const { meta, rows } = JSON.parse(file.text) as ComparisonExport;
    expect(rows.map((r) => r.case)).toEqual(["id:case-1", "id:case-11", "id:case-12"]);
    expect(meta).toMatchObject({
      projectId: "p1",
      baseline: { runId: "run-1", label: BASELINE_LABEL },
      search: "ticket 1",
      filters: [{ kind: "improved", label: "Improved · quality · #2" }],
      sort: { kind: "dataset" },
      counts: { matching: 3, total: 12, inAllRuns: 10 },
      truncatedRuns: [],
    });
    expect(meta.generatedAt).toBe(new Date(2026, 10, 11, 14, 5).toISOString());
    expect(meta.pairs[0].scorers.find((s) => s.name === "quality")?.pairedCount).toBe(3);
  });

  it("pins the regressed case: case 2 alone, with #2's quality pair", async () => {
    render(
      view({
        ...NO_ANALYSIS,
        filters: [{ kind: "regressed", scorer: "quality", runId: CANDIDATE_RUN.id }],
      }),
    );
    const file = await exportAs("JSON");
    const { meta, rows } = JSON.parse(file.text) as ComparisonExport;
    expect(rows.map((r) => r.case)).toEqual(["id:case-2"]);
    expect(meta.filters).toMatchObject([{ kind: "regressed", label: "Regressed · quality · #2" }]);
    expect(meta.counts).toEqual({ matching: 1, total: 12, inAllRuns: 10 });
    expect(meta.pairs[0].scorers.find((s) => s.name === "quality")).toMatchObject({
      pairedCount: 1,
      baselineMean: 0.85,
      candidateMean: 0.3,
      delta: -0.55,
    });
    expect(
      rows[0].runs
        .find((r) => r.runId === CANDIDATE_RUN.id)
        ?.scores.find((s) => s.scorer === "quality"),
    ).toMatchObject({ value: 0.3, change: -0.55, classification: "regressed" });
  });

  it("is off, saying why, when no case matches", async () => {
    render(view({ ...NO_ANALYSIS, q: "no such ticket" }));
    expect(exportButton().hasAttribute("disabled")).toBe(true);
    fireEvent.focus(exportButton().parentElement as HTMLElement);
    expect(
      within(await screen.findByRole("tooltip")).getByText("No cases match the search or filters"),
    ).toBeTruthy();
  });

  it("is off while the runs load, saying so", async () => {
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      loaded(ids).map((q, i) =>
        i === 2 ? { data: undefined, isLoading: true, isError: false } : q,
      ),
    );
    render(view());
    expect(screen.getByText("Comparing…")).toBeTruthy();
    expect(exportButton().hasAttribute("disabled")).toBe(true);
    expect(await offReason()).toBe("Available once the runs load");
  });

  it("is off when a run didn't load", async () => {
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      loaded(ids).map((q, i) =>
        i === 2 ? { data: undefined, isLoading: false, isError: true } : q,
      ),
    );
    render(view());
    expect(screen.getByText("1 run couldn’t be loaded.")).toBeTruthy();
    expect(await offReason()).toBe("No comparison to export");
  });

  it("is off with fewer than two runs, saying there is no comparison", async () => {
    render(
      <CompareRunsView
        projectId="p1"
        runIds={[BASELINE_RUN.id]}
        baselineId={null}
        onChangeBaseline={vi.fn()}
        onChangeRuns={vi.fn()}
        inspected={null}
        onInspect={vi.fn()}
        analysis={NO_ANALYSIS}
      />,
    );
    expect(exportButton().hasAttribute("disabled")).toBe(true);
    expect(await offReason()).toBe("No comparison to export");
  });

  it("is off when the runs share no case", async () => {
    // Each run's cases carry ids of its own, so no case is in two runs.
    const apart = PAIRED_FIXTURE.map((b) => ({
      ...b,
      results: b.results.map((r) => ({ ...r, testCaseId: `${b.run.id}-${r.testCaseId}` })),
    }));
    hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
      ids.map((id) => ({
        data: apart.find((b) => b.run.id === id),
        isLoading: false,
        isError: false,
      })),
    );
    render(view());
    expect(screen.getByText("These runs have no matching inputs")).toBeTruthy();
    expect(await offReason()).toBe("These runs have no matching inputs");
  });
});
