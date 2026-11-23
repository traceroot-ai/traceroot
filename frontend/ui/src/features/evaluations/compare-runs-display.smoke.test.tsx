// @vitest-environment jsdom
/**
 * Reading the comparison table at N runs, on three runs of one 12-case dataset (see
 * `compare/__tests__/paired-fixture.ts`). The Display menu sets row density (compact or
 * comfortable) and whether long text clips to one line or wraps in full. The layout opens
 * as it always has, is kept per viewer and project in the browser (never in the URL), and
 * the page still works when the browser refuses storage. The same menu picks which columns
 * show: Input and Run always do; a hidden column leaves the header, the summary and every
 * case's lines, and the filters and sort keep working on it. While the table scrolls, its
 * label row stays on top and the Input and Run columns stay on the left.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
  POLICY,
  QUALITY,
} from "./compare/__tests__/paired-fixture";
import { NO_ANALYSIS } from "./compare/filters";
import { caseGroup, caseGroups, linesOf, summaryGroup } from "./compare/__tests__/table-grid";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({
  useEvaluationRunDetails: vi.fn(),
  useEvaluationRuns: vi.fn(),
}));
vi.mock("./hooks", () => hooks);

import { CompareRunsView } from "./views/compare-runs-view";

const RUN_IDS = [BASELINE_RUN.id, CANDIDATE_RUN.id, FAST_RUN.id];
const STORAGE_KEY = "traceroot:compare-display:p1";

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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const view = (
  projectId = "p1",
  props: Partial<React.ComponentProps<typeof CompareRunsView>> = {},
) => (
  <CompareRunsView
    projectId={projectId}
    runIds={RUN_IDS}
    baselineId={null}
    onChangeBaseline={vi.fn()}
    onChangeRuns={vi.fn()}
    inspected={null}
    onInspect={vi.fn()}
    {...props}
  />
);

/** Each case's first line, which holds its Input. */
const bodyRows = () => Array.from(document.querySelectorAll<HTMLElement>("tbody tr[data-row]"));
/** Every line of every case. */
const allLines = () => caseGroups().flatMap(linesOf);
const headRows = () => Array.from(document.querySelectorAll<HTMLElement>("thead tr"));
const caseRow = (input: string) => caseGroup(input);
/** The Display menu, opened if it isn't (it stays open while settings change). */
const openDisplay = async () => {
  if (!screen.queryByRole("dialog", { name: "Display" })) {
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
  }
  return within(await screen.findByRole("dialog", { name: "Display" }));
};
const choose = async (setting: string, option: string) => {
  const menu = await openDisplay();
  fireEvent.click(
    within(menu.getByRole("radiogroup", { name: setting })).getByRole("radio", { name: option }),
  );
};
const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
const comfortable = (row: HTMLElement) => row.className.includes("leading-relaxed");

describe("CompareRunsView — display menu", () => {
  it("opens in today's layout: compact rows, long text clipped with its full value on hover", async () => {
    render(view());
    expect(bodyRows().some(comfortable)).toBe(false);
    const input = within(caseRow("Ticket 2")).getByText("Ticket 2");
    expect(input.className).toContain("truncate");
    fireEvent.focus(input);
    expect(within(await screen.findByRole("tooltip")).getByText("Ticket 2")).toBeTruthy();

    const menu = await openDisplay();
    const checked = (setting: string) =>
      within(menu.getByRole("radiogroup", { name: setting }))
        .getAllByRole("radio")
        .filter((r) => r.getAttribute("aria-checked") === "true")
        .map((r) => r.textContent);
    expect(checked("Density")).toEqual(["Compact"]);
    expect(checked("Text")).toEqual(["Clip"]);
  });

  it("spaces every line out when comfortable, and leaves the headers as they are", async () => {
    render(view());
    await choose("Density", "Comfortable");
    expect(allLines()).toHaveLength(36);
    expect(allLines().every(comfortable)).toBe(true);
    expect(headRows().some(comfortable)).toBe(false);
    await choose("Density", "Compact");
    expect(allLines().some(comfortable)).toBe(false);
  });

  it("spaces the summary's lines out too", async () => {
    render(view());
    await choose("Density", "Comfortable");
    expect(linesOf(summaryGroup())).toHaveLength(3);
    expect(linesOf(summaryGroup()).every(comfortable)).toBe(true);
  });

  it("wraps long text in full, with no hover tooltip", async () => {
    render(view());
    await choose("Text", "Wrap");
    const input = within(caseRow("Ticket 2")).getByText("Ticket 2");
    expect(input.className).toContain("whitespace-pre-wrap");
    expect(input.className).not.toContain("truncate");
    const output = within(caseRow("Ticket 2")).getByText("run-2 output");
    expect(output.className).toContain("whitespace-pre-wrap");
    fireEvent.focus(input);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps the viewer's layout for the project, outside the URL", async () => {
    const { unmount } = render(view());
    await choose("Density", "Comfortable");
    await choose("Text", "Wrap");
    expect(stored()).toEqual({
      density: "comfortable",
      text: "wrap",
      hidden: [],
      diff: "baseline",
    });
    unmount();

    render(view());
    expect(bodyRows().every(comfortable)).toBe(true);
    expect(within(caseRow("Ticket 2")).getByText("Ticket 2").className).toContain(
      "whitespace-pre-wrap",
    );
    cleanup();

    // Another project opens in its own (default) layout.
    render(view("p2"));
    expect(bodyRows().some(comfortable)).toBe(false);
  });

  it("opens in the default layout from a stored entry it can't read", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    render(view());
    expect(bodyRows().some(comfortable)).toBe(false);
  });

  it("still switches layout when the browser refuses storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    render(view());
    expect(bodyRows()).toHaveLength(12);
    await choose("Density", "Comfortable");
    expect(bodyRows().every(comfortable)).toBe(true);
  });
});

const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent);
const columnBoxes = async () => {
  const menu = await openDisplay();
  return within(menu.getByRole("group", { name: "Columns" }));
};
const toggle = async (column: string) =>
  fireEvent.click((await columnBoxes()).getByRole("checkbox", { name: column }));
/** Every row's column count, header, summary and cases, counting the columns a cell spans
 *  across lines: a hidden column leaves all of them. */
const cellCounts = () => {
  const spanned = (tr: HTMLTableRowElement) =>
    [...tr.cells].reduce((n, cell) => n + cell.colSpan, 0);
  const lines = [summaryGroup(), ...caseGroups()].flatMap((group) => {
    const [first, ...rest] = linesOf(group);
    // Input and Expected span the group from its first line.
    const spanning = [...first.cells].filter((c) => c.rowSpan > 1).length;
    return [spanned(first), ...rest.map((tr) => spanned(tr) + spanning)];
  });
  return [...headRows().map((tr) => spanned(tr as HTMLTableRowElement)), ...lines];
};

describe("CompareRunsView — columns", () => {
  it("offers every column in the table's order, Input and Run always shown", async () => {
    render(view());
    const labels = headers().map((h) => h?.replace(" (mean)", ""));
    expect(labels).toEqual([
      "Input",
      "Run",
      "Output",
      "Expected",
      POLICY,
      QUALITY,
      "route",
      "Latency",
      "Cost",
    ]);
    const boxes = await columnBoxes();
    const input = boxes.getByRole("checkbox", { name: "Input" }) as HTMLInputElement;
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    const run = boxes.getByRole("checkbox", { name: "Run" }) as HTMLInputElement;
    expect(run.checked).toBe(true);
    expect(run.disabled).toBe(true);
    expect(boxes.getAllByText("Always shown")).toHaveLength(2);
    expect(
      boxes
        .getAllByRole("checkbox")
        .map((b) => [
          b.getAttribute("aria-label") ?? b.closest("label")?.textContent,
          (b as HTMLInputElement).checked,
        ]),
    ).toEqual(labels.map((label) => [label, true]));
  });

  it("hides a column from the header, the summary and every case, and shows it again", async () => {
    render(view());
    const all = headers();
    expect(new Set(cellCounts())).toEqual(new Set([all.length]));

    await toggle("Output");
    await toggle(QUALITY);
    await toggle("Cost");
    expect(headers()).toEqual(["Input", "Run", "Expected", POLICY, "route", "Latency (mean)"]);
    expect(new Set(cellCounts())).toEqual(new Set([6]));
    expect(within(caseRow("Ticket 2")).queryByText("run-2 output")).toBeNull();

    await toggle("Output");
    expect(headers()).toEqual([
      "Input",
      "Run",
      "Output",
      "Expected",
      POLICY,
      "route",
      "Latency (mean)",
    ]);
    expect(within(caseRow("Ticket 2")).getByText("run-2 output")).toBeTruthy();
  });

  it("keeps hidden columns hidden on reload, for this project only", async () => {
    const { unmount } = render(view());
    await toggle(QUALITY);
    await toggle("Latency");
    expect(stored()).toMatchObject({ hidden: [`metric:${QUALITY}`, "latency"] });
    unmount();

    render(view());
    expect(headers()).not.toContain(QUALITY);
    expect(headers()).not.toContain("Latency (mean)");
    cleanup();

    render(view("p2"));
    expect(headers()).toContain(QUALITY);
  });

  it("keeps a filter on a hidden metric picking its cases", async () => {
    render(
      view("p1", {
        analysis: {
          ...NO_ANALYSIS,
          filters: [{ kind: "regressed", scorer: QUALITY, runId: CANDIDATE_RUN.id }],
        },
      }),
    );
    expect(bodyRows().map((tr) => tr.querySelector("td")?.textContent)).toEqual(["Ticket 2"]);
    await toggle(QUALITY);
    expect(headers()).not.toContain(QUALITY);
    expect(bodyRows().map((tr) => tr.querySelector("td")?.textContent)).toEqual(["Ticket 2"]);
    expect(
      screen.getByRole("button", { name: "Remove filter: Regressed · quality · #2" }),
    ).toBeTruthy();
  });

  it("keeps a sort on a hidden metric ordering the cases", async () => {
    render(
      view("p1", {
        analysis: {
          ...NO_ANALYSIS,
          sort: { kind: "regression", scorer: QUALITY, runId: CANDIDATE_RUN.id },
        },
      }),
    );
    const order = () => bodyRows().map((tr) => tr.querySelector("td")?.textContent);
    const sorted = order();
    expect(sorted.slice(0, 2)).toEqual(["Ticket 2", "Ticket 3"]);
    await toggle(QUALITY);
    expect(headers()).not.toContain(QUALITY);
    expect(order()).toEqual(sorted);
  });

  it("spans the shown columns when no case matches", async () => {
    render(view("p1", { analysis: { ...NO_ANALYSIS, q: "no such ticket" } }));
    await toggle("Expected");
    await toggle(POLICY);
    const bodies = document.querySelectorAll("tbody");
    const empty = bodies[bodies.length - 1].querySelector("td") as HTMLTableCellElement;
    expect(empty.colSpan).toBe(headers().length);
  });
});

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

  it("pins the Input column, in the header, the summary and every case, and the Run column", async () => {
    render(view());
    const rows = [...headRows(), linesOf(summaryGroup())[0], ...bodyRows()];
    expect(rows).toHaveLength(14);
    expect(rows.every((tr) => pinned(tr.querySelector("th, td")))).toBe(true);
    expect(document.querySelectorAll(".col-sticky-start")).toHaveLength(14);
    // Run is pinned at Input's width, in the header and on every line.
    expect(document.querySelectorAll(".left-\\[240px\\]")).toHaveLength(1 + 3 + 36);

    // Hiding the columns beside it leaves Input pinned.
    await toggle("Output");
    await toggle("Expected");
    expect(rows.every((tr) => pinned(tr.querySelector("th, td")))).toBe(true);
    expect(screen.getAllByRole("columnheader")[0].textContent).toBe("Input");
  });
});
