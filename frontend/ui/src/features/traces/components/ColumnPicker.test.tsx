// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { ColumnPicker } from "./ColumnPicker";
import { FIXED_COLUMNS, visibleFixedColumns, type FixedColumnId } from "@/features/traces/columns";

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

afterEach(cleanup);

/** Every column the picker lists, in row order. Written out rather than derived from the
 * registry so that adding, removing or reordering a column fails here and gets looked at. */
const ALL_COLUMN_LABELS = [
  "Timestamp",
  "Name",
  "Trace ID",
  "Errors",
  "Spans",
  "Input",
  "Output",
  "Metadata",
  "User ID",
  "Session ID",
  "Input usage",
  "Output usage",
  "Total usage",
  "Tokens",
  "Cost",
  "Latency",
];

/** The ones that are off for a user who has never opened the picker. */
const DEFAULT_OFF_LABELS = [
  "Metadata",
  "User ID",
  "Session ID",
  "Input usage",
  "Output usage",
  "Total usage",
];

/** The badge reads shown out of available. Both sides come from the registry so that adding a
 * column moves these expectations with it instead of leaving them quietly wrong. */
const TOTAL_COLUMN_COUNT = FIXED_COLUMNS.length;
const DEFAULT_SHOWN_COUNT = visibleFixedColumns([]).length;
const columnRatio = (shownCount: number) => `${shownCount}/${TOTAL_COLUMN_COUNT}`;

const LAST_COLUMN_TITLE = "The list needs at least one column";

interface PickerProps {
  visibleColumns?: FixedColumnId[];
  onToggleField?: (id: FixedColumnId) => void;
  onReset?: () => void;
}

function renderPicker(props: PickerProps = {}) {
  const onToggleField = props.onToggleField ?? vi.fn();
  const onReset = props.onReset ?? vi.fn();
  render(
    <ColumnPicker
      // The default is the resolved default-on set, the state the picker actually opens in
      // for a new user — an empty list would be the guarded last-column case instead.
      visibleColumns={props.visibleColumns ?? visibleFixedColumns([])}
      onToggleField={onToggleField}
      onReset={onReset}
    />,
  );
  return { onToggleField, onReset };
}

/** A parent that owns the column state the way the hook does, storing flips from the registry
 * defaults: without it a toggle changes nothing on screen and no check state can be observed. */
function ControlledPicker({ initialFlips = [] }: { initialFlips?: FixedColumnId[] }) {
  const [flipped, setFlipped] = useState<FixedColumnId[]>(initialFlips);
  return (
    <ColumnPicker
      visibleColumns={visibleFixedColumns(flipped)}
      onToggleField={(id) =>
        setFlipped((current) =>
          current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
        )
      }
      onReset={() => setFlipped([])}
    />
  );
}

const getTrigger = () => screen.getByRole("button", { name: /^Columns/ });

function openPicker(): HTMLElement {
  fireEvent.click(getTrigger());
  return screen.getByRole("dialog", { name: "Choose columns" });
}

/** The column toggles, in DOM order. `Reset to default` is an action, not a column. */
function columnToggles(): HTMLButtonElement[] {
  return within(screen.getByRole("dialog", { name: "Choose columns" }))
    .getAllByRole("button")
    .filter((button) => button.textContent !== "Reset to default") as HTMLButtonElement[];
}

const columnLabels = () => columnToggles().map((button) => button.textContent);

function columnToggle(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

/** Which columns read as shown, by the state assistive technology is given. */
const pressedLabels = () =>
  columnToggles()
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);

describe("ColumnPicker trigger", () => {
  it("labels the trigger Columns and says what it does", () => {
    renderPicker();
    expect(getTrigger().textContent).toContain("Columns");
    expect(getTrigger().getAttribute("title")).toBe("Choose which fields appear as columns");
  });

  it("reads the default-on count over the registry total, where the user has turned nothing off", () => {
    // A ratio, not a hidden-count: a fresh install must not read as the user hiding columns.
    renderPicker();
    expect(within(getTrigger()).getByText(columnRatio(DEFAULT_SHOWN_COUNT))).toBeTruthy();
  });

  it("lowers the shown side when a default column is turned off", () => {
    renderPicker({ visibleColumns: visibleFixedColumns(["cost"]) });
    expect(within(getTrigger()).getByText(columnRatio(DEFAULT_SHOWN_COUNT - 1))).toBeTruthy();
  });

  it("raises the shown side when an opt-in column is turned on", () => {
    // Turning a column on shows one more of the same total, so the ratio must move for it.
    render(<ControlledPicker />);
    expect(within(getTrigger()).getByText(columnRatio(DEFAULT_SHOWN_COUNT))).toBeTruthy();
    openPicker();
    fireEvent.click(columnToggle("User ID"));
    expect(within(getTrigger()).getByText(columnRatio(DEFAULT_SHOWN_COUNT + 1))).toBeTruthy();
  });
});

describe("ColumnPicker contents", () => {
  it("lists every column in the order the row renders them", () => {
    renderPicker();
    openPicker();
    expect(columnLabels()).toEqual(ALL_COLUMN_LABELS);
  });

  it("checks the columns shown by default and leaves the opt-in columns unchecked", () => {
    renderPicker();
    openPicker();
    expect(pressedLabels()).toEqual(
      ALL_COLUMN_LABELS.filter((label) => !DEFAULT_OFF_LABELS.includes(label)),
    );
  });

  it("reflects a hidden default and a shown opt-in column in the check state", () => {
    renderPicker({ visibleColumns: visibleFixedColumns(["input", "user_id"]) });
    openPicker();
    expect(columnToggle("Input").getAttribute("aria-pressed")).toBe("false");
    expect(columnToggle("User ID").getAttribute("aria-pressed")).toBe("true");
  });

  it("lists the Metadata column but never enumerates metadata keys", () => {
    // A per-key column is a consequence of filtering on that key, so the picker offers no
    // second way in: no search box, no key list, and the fixed Metadata column is one toggle
    // for the whole payload rather than a per-key one.
    renderPicker();
    openPicker();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(columnLabels()).toEqual(ALL_COLUMN_LABELS);
    expect(columnLabels()).toContain("Metadata");
  });
});

describe("ColumnPicker toggling", () => {
  it("reports the column a click toggles", () => {
    const { onToggleField } = renderPicker();
    openPicker();
    fireEvent.click(columnToggle("Input"));
    expect(onToggleField).toHaveBeenCalledWith("input");
  });

  it("unchecks a default column that is turned off", () => {
    render(<ControlledPicker />);
    openPicker();
    fireEvent.click(columnToggle("Input"));
    expect(columnToggle("Input").getAttribute("aria-pressed")).toBe("false");
    expect(pressedLabels()).not.toContain("Input");
  });

  it("checks an opt-in column that is turned on", () => {
    render(<ControlledPicker />);
    openPicker();
    fireEvent.click(columnToggle("Session ID"));
    expect(columnToggle("Session ID").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the popover open so several columns can be changed in one visit", () => {
    render(<ControlledPicker />);
    openPicker();
    fireEvent.click(columnToggle("Input"));
    fireEvent.click(columnToggle("Output"));
    expect(screen.getByRole("dialog", { name: "Choose columns" })).toBeTruthy();
    expect(pressedLabels()).toEqual(
      ALL_COLUMN_LABELS.filter(
        (label) => ![...DEFAULT_OFF_LABELS, "Input", "Output"].includes(label),
      ),
    );
  });

  it("keeps the columns listed in registry order after a toggle", () => {
    // The list is the registry, not a shown-first ordering that reshuffles under the click.
    render(<ControlledPicker />);
    openPicker();
    fireEvent.click(columnToggle("Timestamp"));
    expect(columnLabels()).toEqual(ALL_COLUMN_LABELS);
  });
});

describe("ColumnPicker last remaining column", () => {
  it("cannot turn off the only column left", () => {
    // A table with no columns has no rows to click and no header to recover from, so the
    // picker must not be able to produce one.
    const { onToggleField } = renderPicker({ visibleColumns: ["timestamp"] });
    openPicker();
    const lastColumn = columnToggle("Timestamp");
    expect(lastColumn.disabled).toBe(true);
    expect(lastColumn.getAttribute("title")).toBe(LAST_COLUMN_TITLE);

    fireEvent.click(lastColumn);
    expect(onToggleField).not.toHaveBeenCalled();
  });

  it("still lets every hidden column be turned on while one column is left", () => {
    // The guard is on the last column standing, not on the picker as a whole.
    const { onToggleField } = renderPicker({ visibleColumns: ["timestamp"] });
    openPicker();
    const others = columnToggles().filter((button) => button.textContent !== "Timestamp");
    expect(others).toHaveLength(ALL_COLUMN_LABELS.length - 1);
    others.forEach((button) => expect(button.disabled).toBe(false));

    fireEvent.click(columnToggle("Latency"));
    expect(onToggleField).toHaveBeenCalledWith("latency");
  });

  it("guards whichever column is the last one, not a privileged one", () => {
    renderPicker({ visibleColumns: ["latency"] });
    openPicker();
    expect(columnToggle("Latency").disabled).toBe(true);
    expect(columnToggle("Timestamp").disabled).toBe(false);
  });

  it("releases the guard as soon as a second column is shown", () => {
    render(<ControlledPicker initialFlips={visibleFixedColumns([]).slice(1)} />);
    openPicker();
    expect(columnToggle("Timestamp").disabled).toBe(true);

    fireEvent.click(columnToggle("Cost"));

    expect(columnToggle("Timestamp").disabled).toBe(false);
    expect(columnToggle("Cost").disabled).toBe(false);
  });
});

describe("ColumnPicker reset", () => {
  it("offers Reset to default as an action beside the columns, not as one of them", () => {
    renderPicker();
    const content = openPicker();
    expect(within(content).getByRole("button", { name: "Reset to default" })).toBeTruthy();
    expect(columnLabels()).not.toContain("Reset to default");
  });

  it("puts a hidden default back and drops an opt-in column on reset", () => {
    render(<ControlledPicker initialFlips={["input", "user_id"]} />);
    const content = openPicker();
    fireEvent.click(within(content).getByRole("button", { name: "Reset to default" }));
    expect(pressedLabels()).toEqual(
      ALL_COLUMN_LABELS.filter((label) => !DEFAULT_OFF_LABELS.includes(label)),
    );
  });
});
