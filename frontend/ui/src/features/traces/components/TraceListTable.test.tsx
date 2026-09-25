// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import type { TraceListItem } from "@/types/api";
import { visibleFixedColumns, type FixedColumnId } from "@/features/traces/columns";
import { TraceListTable } from "./TraceListTable";

afterEach(cleanup);

// The ten columns a user who never touches the picker sees. Nothing added, nothing hidden.
const DEFAULT_COLUMNS = [
  "Timestamp",
  "Name",
  "Trace ID",
  "Errors",
  "Spans",
  "Input",
  "Output",
  "Tokens",
  "Cost",
  "Latency",
];

// Rows arrive with `metadata_map`, the parsed map the list query selects — the cells
// read that, not the legacy `metadata` JSON blob.
function makeTrace(overrides: Partial<TraceListItem> & { trace_id: string }): TraceListItem {
  return {
    project_id: "p-1",
    name: "run",
    trace_start_time: "2026-06-01T00:00:00.000Z",
    user_id: null,
    session_id: null,
    span_count: 2,
    duration_ms: 120,
    error_count: 0,
    input: "in",
    output: "out",
    ...overrides,
  };
}

interface TableProps {
  traces: TraceListItem[];
  visibleColumns?: FixedColumnId[];
  onSelectTrace?: (traceId: string) => void;
}

function renderTable(props: TableProps) {
  const onSelectTrace = props.onSelectTrace ?? vi.fn();
  render(
    <TraceListTable
      traces={props.traces}
      selectedTraceId={null}
      onSelectTrace={onSelectTrace}
      // The resolved default-on set, never an empty list: empty is the "no columns selected"
      // table, which would quietly pass assertions about columns nobody rendered.
      visibleColumns={props.visibleColumns ?? visibleFixedColumns([])}
    />,
  );
  return { onSelectTrace };
}

const headerNames = () => screen.getAllByRole("columnheader").map((th) => th.textContent);

function headerCell(name: string): HTMLElement {
  const header = screen.getAllByRole("columnheader").find((th) => th.textContent === name);
  if (!header) throw new Error(`no column header named ${name}`);
  return header;
}

/** The cell under the named column for a row, located the way a reader locates it. */
function cellAt(traceId: string, columnName: string): HTMLElement {
  const columnIndex = headerNames().indexOf(columnName);
  if (columnIndex === -1) throw new Error(`no column header named ${columnName}`);
  const row = screen.getByText(traceId).closest("tr");
  if (!row) throw new Error(`no row for ${traceId}`);
  return row.querySelectorAll("td")[columnIndex] as HTMLElement;
}

const classesOf = (element: Element) => element.className.split(/\s+/);

/** The Tailwind sizing classes on a cell, which are what fix a column's width. */
const widthClassesOf = (element: Element) =>
  classesOf(element).filter((name) => /^(?:w|min-w|max-w)-/.test(name));

/** The right-hand divider, present on every cell except the one that ends the row. */
const hasRowDivider = (element: Element) => classesOf(element).includes("border-r");

describe("TraceListTable default columns", () => {
  it("renders exactly the ten default columns, in registry order, when nothing has been changed", () => {
    // `toEqual` on the whole array is deliberate: it pins the set and the order together,
    // which is what "unchanged for existing users" means now that every column is togglable.
    renderTable({
      traces: [makeTrace({ trace_id: "t-1", metadata_map: { session_id: "s-1" } })],
    });
    expect(headerNames()).toEqual(DEFAULT_COLUMNS);
    expect(screen.queryByText("s-1")).toBeNull();
  });

  it("renders neither the header nor the cell for a default column turned off", () => {
    renderTable({
      traces: [makeTrace({ trace_id: "t-1", input: "the-input" })],
      visibleColumns: visibleFixedColumns(["input"]),
    });
    expect(headerNames()).toEqual(DEFAULT_COLUMNS.filter((name) => name !== "Input"));
    expect(screen.queryByText("the-input")).toBeNull();
  });

  it("renders an opt-in column turned on alongside the ten", () => {
    renderTable({
      traces: [makeTrace({ trace_id: "t-1", session_id: "s-1" })],
      visibleColumns: visibleFixedColumns(["session_id"]),
    });
    expect(headerNames()).toContain("Session ID");
    expect(cellAt("t-1", "Session ID").textContent).toBe("s-1");
  });

  it("says so rather than rendering an empty grid when no column is left", () => {
    // Reachable only through storage, since the picker guards the last column — but a row
    // per trace with no cells in it collapses the table and reads as "no traces".
    renderTable({ traces: [makeTrace({ trace_id: "t-1" })], visibleColumns: [] });
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    expect(screen.getByText("No columns selected. Choose one from the Columns menu.")).toBeTruthy();
    expect(screen.queryByText("t-1")).toBeNull();
  });
});

describe("TraceListTable opt-in field columns", () => {
  it("places an opt-in column after Output and before Tokens", () => {
    renderTable({
      traces: [makeTrace({ trace_id: "t-1", user_id: "u-1" })],
      visibleColumns: visibleFixedColumns(["user_id"]),
    });
    const names = headerNames();
    expect(names.indexOf("User ID")).toBeGreaterThan(names.indexOf("Output"));
    expect(names.indexOf("User ID")).toBeLessThan(names.indexOf("Tokens"));
  });

  it("renders the opt-in columns in registry order whatever order they were turned on in", () => {
    // Turning Session ID on before User ID does not put Session ID first: the resolved list
    // is registry order, so the two columns land in the order `FIXED_COLUMNS` lists them.
    renderTable({
      traces: [makeTrace({ trace_id: "t-1", user_id: "u-1", session_id: "s-1" })],
      visibleColumns: visibleFixedColumns(["session_id", "user_id"]),
    });
    const names = headerNames();
    expect(names.indexOf("User ID")).toBeLessThan(names.indexOf("Session ID"));
    expect(names.indexOf("User ID")).toBe(names.indexOf("Output") + 1);
    expect(names.indexOf("Tokens")).toBe(names.indexOf("Session ID") + 1);
  });

  it("renders the row's value as plain text", () => {
    renderTable({
      traces: [makeTrace({ trace_id: "t-1", user_id: "u-1" })],
      visibleColumns: visibleFixedColumns(["user_id"]),
    });
    const cell = cellAt("t-1", "User ID");
    expect(cell.textContent).toBe("u-1");
    expect(within(cell).queryByRole("button")).toBeNull();
  });

  // A payload that never carries the key reaches the cell as undefined rather than null, and a
  // null-only placeholder check renders it as a blank gap instead of the table's "-".
  it.each([["null", null] as const, ["undefined", undefined] as const])(
    "renders a dash when the row's field is %s",
    (_case, value) => {
      renderTable({
        traces: [makeTrace({ trace_id: "t-1", user_id: value, session_id: "s-1" })],
        visibleColumns: visibleFixedColumns(["user_id", "session_id"]),
      });
      expect(cellAt("t-1", "User ID").textContent).toBe("-");
      expect(cellAt("t-1", "Session ID").textContent).toBe("s-1");
    },
  );

  it("opens the trace when a fixed cell is clicked", () => {
    const { onSelectTrace } = renderTable({
      traces: [makeTrace({ trace_id: "t-1", user_id: "u-1" })],
      visibleColumns: visibleFixedColumns(["user_id"]),
    });
    fireEvent.click(screen.getByText("u-1"));
    expect(onSelectTrace).toHaveBeenCalledWith("t-1");
  });
});

describe("TraceListTable header widths", () => {
  // A header sizes one of two ways, and the split is exactly "a default-on column keeps its
  // own registered width; an opted-in one takes the shared added-column width".
  it("sizes a default-on column with its own registered width", () => {
    renderTable({ traces: [makeTrace({ trace_id: "t-1" })] });
    expect(widthClassesOf(headerCell("Timestamp"))).toEqual(["w-[140px]"]);
    expect(widthClassesOf(headerCell("Tokens"))).toEqual(["w-[100px]"]);
  });

  it("sizes an opt-in field column with the shared added-column width", () => {
    // Sizing an opted-in column from the width table instead would leave it unconstrained,
    // since that table holds entries for the default-on columns only.
    renderTable({
      traces: [makeTrace({ trace_id: "t-1", user_id: "u-1" })],
      visibleColumns: visibleFixedColumns(["user_id"]),
    });
    expect(widthClassesOf(headerCell("User ID"))).toEqual(["w-[140px]", "max-w-[180px]"]);
  });
});

describe("TraceListTable row-ending divider", () => {
  // The divider is positional: whichever column the user leaves ending the row goes without
  // one, so hiding the columns that used to end it leaves no stray rule against the edge.
  it("draws no divider on a default column that ends the row", () => {
    renderTable({ traces: [makeTrace({ trace_id: "t-1" })] });
    expect(hasRowDivider(headerCell("Cost"))).toBe(true);
    expect(hasRowDivider(headerCell("Latency"))).toBe(false);
    expect(hasRowDivider(cellAt("t-1", "Latency"))).toBe(false);
  });

  it("draws no divider on an opt-in field column that ends the row", () => {
    // Every column that used to follow it is hidden, so an opted-in one now ends the row.
    renderTable({
      traces: [makeTrace({ trace_id: "t-1", total_input_tokens: 4, total_output_tokens: 6 })],
      visibleColumns: visibleFixedColumns(["tokens", "cost", "latency", "total_usage"]),
    });
    expect(headerNames().at(-1)).toBe("Total usage");
    expect(hasRowDivider(headerCell("Output"))).toBe(true);
    expect(hasRowDivider(headerCell("Total usage"))).toBe(false);
    // The body row walks the same column list, so its last cell has to agree with the header.
    expect(hasRowDivider(cellAt("t-1", "Total usage"))).toBe(false);
  });
});

/**
 * The Metadata column: one truncated line per row, the whole payload revealed on hover or
 * keyboard activation. It is off by default, so every assertion names it in `visibleColumns`.
 *
 * A warning for whoever adds a row-wide button count: this cell is a control, so a query over
 * a whole row finds one button no other cell accounts for. That is why the assertions about
 * the other cells' inertness stay cell-scoped.
 */
describe("TraceListTable metadata reveal", () => {
  // Radix's popover positioning observes its anchor, and jsdom ships no ResizeObserver.
  beforeAll(() => {
    if (!("ResizeObserver" in globalThis)) {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  /** A payload the collapsed line provably cannot show in full: the preview is capped at 80
   * characters, so the trailing keys of these five pairs exist only in the reveal. */
  const WIDE_METADATA = {
    tenant: "acme",
    region: "eu-west-1",
    deployment: "canary-2026-06-01",
    release: "v4.12.0-rc3",
    operator: "scheduled-backfill",
  };

  /** A key that falls outside the cap, and the value under it. */
  const CUT_OFF_KEY = "operator";
  const CUT_OFF_VALUE = "scheduled-backfill";

  function renderMetadataColumn(metadataMap?: Record<string, string>) {
    const rendered = renderTable({
      traces: [makeTrace({ trace_id: "t-1", metadata_map: metadataMap })],
      visibleColumns: visibleFixedColumns(["metadata"]),
    });
    return { ...rendered, cell: cellAt("t-1", "Metadata") };
  }

  /** The collapsed line, which is also the control that opens the reveal. */
  const metadataTrigger = (cell: HTMLElement) => within(cell).getByRole("button");

  const revealSurface = () => screen.getByRole("dialog", { name: "Metadata" });
  const queryRevealSurface = () => screen.queryByRole("dialog", { name: "Metadata" });

  it("shows the payload as one truncated line and hangs nothing off a title attribute", () => {
    // A `title` was the old reveal, rendering the payload as one unformatted unselectable run,
    // so its absence is part of the feature rather than an oversight.
    const { cell } = renderMetadataColumn(WIDE_METADATA);
    const trigger = metadataTrigger(cell);
    const preview = trigger.textContent ?? "";
    expect(preview).toContain("tenant");
    expect(preview.endsWith("...")).toBe(true);
    expect(preview).not.toContain(CUT_OFF_KEY);
    // One line: the collapsed cell shows the compact spelling, never the pretty-printed one.
    expect(preview).not.toContain("\n");
    expect(trigger.hasAttribute("title")).toBe(false);
    expect(cell.querySelector("[title]")).toBeNull();
  });

  it("opens the reveal on hover with the metadata keys in it", () => {
    const { cell } = renderMetadataColumn(WIDE_METADATA);
    expect(queryRevealSurface()).toBeNull();

    fireEvent.pointerEnter(metadataTrigger(cell));

    const surface = revealSurface();
    for (const key of Object.keys(WIDE_METADATA)) {
      expect(surface.textContent).toContain(key);
    }
    // The pair the collapsed line had no room for is in the reveal, which is its whole point.
    expect(surface.textContent).toContain(CUT_OFF_VALUE);
  });

  it("renders a dash and opens nothing for a trace carrying no metadata", () => {
    // An empty object would read as metadata the trace recorded; the dash reads as the
    // missing value it is, and a cell with nothing to reveal carries no control at all.
    const { cell } = renderMetadataColumn();
    expect(cell.textContent).toBe("-");
    expect(within(cell).queryByRole("button")).toBeNull();

    fireEvent.pointerEnter(cell);

    expect(queryRevealSurface()).toBeNull();
  });

  it("does not select the row when the trigger is clicked", () => {
    // The row opens the trace, so revealing metadata must not also navigate — and the
    // reveal has to survive the click that Radix would otherwise read as a toggle-shut.
    const { cell, onSelectTrace } = renderMetadataColumn(WIDE_METADATA);
    const trigger = metadataTrigger(cell);
    fireEvent.pointerEnter(trigger);
    expect(revealSurface()).toBeTruthy();

    fireEvent.click(trigger, { detail: 1 });

    expect(onSelectTrace).not.toHaveBeenCalled();
    expect(revealSurface()).toBeTruthy();
  });

  it("does not select the row when the surface itself is clicked", () => {
    // The surface is portaled out of the row, but React events bubble through the component
    // tree rather than the DOM tree, so a click in it still reaches the row's handler.
    const { cell, onSelectTrace } = renderMetadataColumn(WIDE_METADATA);
    fireEvent.pointerEnter(metadataTrigger(cell));
    const surface = revealSurface();

    fireEvent.click(surface);

    expect(onSelectTrace).not.toHaveBeenCalled();
    expect(revealSurface()).toBeTruthy();
  });

  it("opens on keyboard activation and moves focus into the surface", () => {
    // Enter and Space arrive as a click with no originating pointer, which `detail: 0`
    // reproduces. Focus has to follow, or the surface is unreachable without a mouse.
    const { cell, onSelectTrace } = renderMetadataColumn(WIDE_METADATA);

    fireEvent.click(metadataTrigger(cell), { detail: 0 });

    expect(revealSurface().contains(document.activeElement)).toBe(true);
    expect(onSelectTrace).not.toHaveBeenCalled();
  });

  it("stays open while the pointer crosses from the trigger into the surface", () => {
    // The surface is placed clear of the trigger, so closing on the first pointerleave would
    // put the revealed document out of reach: the gap has to be crossable.
    vi.useFakeTimers();
    try {
      const { cell } = renderMetadataColumn(WIDE_METADATA);
      const trigger = metadataTrigger(cell);
      fireEvent.pointerEnter(trigger);
      const surface = revealSurface();

      fireEvent.pointerLeave(trigger);
      fireEvent.pointerEnter(surface);
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(revealSurface()).toBeTruthy();

      fireEvent.pointerLeave(surface);
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(queryRevealSurface()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
