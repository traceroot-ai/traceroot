import { screen, within } from "@testing-library/react";

/**
 * The comparison table as a reader scans it: each case is a group of lines (a `<tbody>`),
 * one line per run, with Input and Expected spanning the group and a failed run's message
 * spanning several columns. These helpers resolve those spans, so a test can ask for the
 * cell under a column on one run's line.
 */

/** The comparison's table; the trace panel has tables of its own. */
export const comparisonTable = () => screen.getAllByRole("table")[0];

/** The case group (`<tbody>`) holding `text`. */
export function caseGroup(text: string): HTMLElement {
  const group = within(comparisonTable()).getByText(text).closest("tbody");
  if (!group) throw new Error(`no case group for ${text}`);
  return group;
}

/** The summary's group, first in the body: "All cases", or "Matching cases" while a
 *  search or filters narrow them. */
export const summaryGroup = () =>
  within(comparisonTable()).getByRole("rowgroup", { name: /^(All|Matching) cases$/ });

/** Every case group, in table order (the summary group and the empty row excluded); none
 *  when there is no table. */
export const caseGroups = () =>
  [...(screen.queryAllByRole("table")[0]?.querySelectorAll<HTMLElement>("tbody") ?? [])].filter(
    (g) => g.querySelector("tr[data-row]"),
  );

/** A group's lines, in order. */
export const linesOf = (group: HTMLElement) => [
  ...group.querySelectorAll<HTMLTableRowElement>(":scope > tr"),
];

/** The line for one run. */
export function lineOf(group: HTMLElement, runId: string): HTMLTableRowElement {
  const line = group.querySelector<HTMLTableRowElement>(`:scope > tr[data-run-id="${runId}"]`);
  if (!line) throw new Error(`no line for ${runId}`);
  return line;
}

/** The index of the column headed `header` (the first whose label starts with it). */
export function columnIndex(header: string): number {
  const index = within(comparisonTable())
    .getAllByRole("columnheader")
    .findIndex((h) => h.textContent?.startsWith(header));
  if (index < 0) throw new Error(`no column ${header}`);
  return index;
}

/** Each line's cells by column, a spanning cell repeated in every slot it covers. */
function grid(group: HTMLElement): HTMLTableCellElement[][] {
  const lines = linesOf(group);
  const slots: HTMLTableCellElement[][] = lines.map(() => []);
  lines.forEach((line, r) => {
    let c = 0;
    for (const cell of [...line.cells]) {
      while (slots[r][c]) c += 1;
      for (let dr = 0; dr < Math.max(1, cell.rowSpan); dr += 1) {
        for (let dc = 0; dc < Math.max(1, cell.colSpan); dc += 1) {
          if (slots[r + dr]) slots[r + dr][c + dc] = cell;
        }
      }
      c += Math.max(1, cell.colSpan);
    }
  });
  return slots;
}

/** The cell under `header` on `runId`'s line. */
export function cellAt(group: HTMLElement, runId: string, header: string): HTMLTableCellElement {
  const r = linesOf(group).indexOf(lineOf(group, runId));
  const cell = grid(group)[r][columnIndex(header)];
  if (!cell) throw new Error(`no cell under ${header} for ${runId}`);
  return cell;
}

/** The cells under `header`, one per line (a spanning cell repeated). */
export const columnCells = (group: HTMLElement, header: string) =>
  grid(group).map((line) => line[columnIndex(header)]);

/** What a cell shows on screen: text read only to screen readers is left out. */
export function shownText(cell: Element): string {
  const copy = cell.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return copy.textContent ?? "";
}

/** What each line shows under `header`, in line order. */
export const columnTexts = (group: HTMLElement, header: string) =>
  columnCells(group, header).map((cell) => (cell ? shownText(cell) : ""));
